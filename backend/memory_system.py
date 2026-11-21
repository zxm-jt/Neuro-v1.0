import json
import math
import os
import re
import datetime
import urllib.request
from collections import Counter

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BACKEND_DIR)

try:
    import secret_store
except Exception:
    secret_store = None


def _load_full_cfg():

    if secret_store is not None:
        try:
            return secret_store.load_config(os.path.join(PROJECT_ROOT, "config.json"))
        except Exception:
            pass
    try:
        with open(os.path.join(PROJECT_ROOT, "config.json"), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

MEM_DIR = os.path.join(PROJECT_ROOT, "memory")

RESIDENT_FILE = "resident.json"
MEMORIES_FILE = "memories.json"
LEGACY_FILE = "memory_store.json"
LAST_FORGET_FILE = "memory_last_forget.txt"

DEFAULT_HALF_LIFE_DAYS = 3.0
DEFAULT_FORGET_SCORE = 1.0
MAX_FRAGMENTS = 48
MAX_PER_SESSION = 2
MAX_FRAGMENT_CHARS = 160

def trim_fragment(text, cap=None):

    t = (text or "").strip()
    cap = int(cap or MAX_FRAGMENT_CHARS)
    if len(t) <= cap:
        return t
    head = t[:cap]
    for sep in (". ", "! ", "? ", "; "):
        i = head.rfind(sep)
        if i >= int(cap * 0.30):
            return head[:i + 1].rstrip()
    i = head.rfind(" ")
    if i >= int(cap * 0.5):
        head = head[:i]
    return head.rstrip(" ,;:-") + "…"
KEEP_MIN_IMPORTANCE = 8

DEFAULT_RETRIEVAL_THRESHOLD = 0.38
DEFAULT_FORCE_THRESHOLD = 0.30
DEFAULT_RETRIEVAL_THRESHOLD_TFIDF = 0.12
DEFAULT_FORCE_THRESHOLD_TFIDF = 0.05
MAX_INJECT = 2
FORCE_MAX_INJECT = 2
TAG_BOOST = 3.0
SEMANTIC_W = 0.55
TAG_W = 0.45
MOOD_W = 0.15
SEMANTIC_MARGIN = 0.0
TOP2_RATIO = 0.80


RESIDENT_RULES = [
    "1. Don't bring up or recap past conversations on your own initiative.",
    "2. You possess past memories, but they are your INTERNAL BACKGROUND, not opening topics.",
    "3. You don't need to prove you remember; silent remembering is more human than saying it.",
    "4. When YOU start a conversation on your own, you may use a past memory.",
    "5. Code of ANY language (C++, Python, JavaScript, shell, etc.) is WRITTEN, never "
    "spoken. When user asks for code, output ONLY the [[CPP_BEGIN]]...[[CPP_END]] block - "
    "do NOT read the code aloud, do NOT recap it in words, do NOT narrate it line by line, "
    "and never let marker fragments (like 'P_BEGIN') reach your speech.",
]


def _cfg_memory():
    return _load_full_cfg().get("memory") or {}


def _path(name):
    return os.path.join(MEM_DIR, name)


def _embed_enabled():
    try:
        emb = (_cfg_memory().get("embeddings") or {})
        return bool(emb.get("enabled"))
    except Exception:
        return False


def _embed_batch(texts):

    if not texts:
        return []
    cfg = _cfg_memory().get("embeddings") or {}
    full = _load_full_cfg()
    llm = full.get("llm") or {}
    zhipu = (full.get("vision") or {}).get("free") or {}
    model = cfg.get("model") or "embedding-3"
    key = (cfg.get("api_key") or "").strip()
    base = (cfg.get("url") or "").strip()

    if not base or not key:
        for cand in (zhipu, llm):
            u = (cand.get("api_url") or cand.get("upstream_url") or "").strip()
            k = (cand.get("api_key") or "").strip()
            if u and "bigmodel.cn" in u and k:
                if not base:
                    base = u.rstrip("/") + "/embeddings"
                if not key:
                    key = k
                break
    if not base:
        base = (llm.get("upstream_url") or "https://open.bigmodel.cn/api/paas/v4").rstrip("/") + "/embeddings"
    if not key:
        key = (llm.get("api_key") or "")
    if not key:
        return None
    body = json.dumps({"model": model, "input": texts}).encode("utf-8")
    req = urllib.request.Request(
        base, data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    _to = float((_cfg_memory().get("timeout_s") or 6))
    try:
        with urllib.request.urlopen(req, timeout=max(1.0, _to)) as resp:
            j = json.loads(resp.read().decode("utf-8"))
        data = j.get("data") or []
        if not data:
            return None
        data.sort(key=lambda d: d.get("index", 0))
        vecs = [d.get("embedding") for d in data]
        return vecs if all(isinstance(v, list) and v for v in vecs) else None
    except Exception as e:
        print(f"[memory] embedding 调用失败（降级 TF-IDF）: {e}", flush=True)
        return None


def _ensure_embeddings(frags):

    if not _embed_enabled() or not frags:
        return
    need = [f for f in frags if not (isinstance(f.get("vec"), list) and f["vec"])]
    if not need:
        return
    texts = [(str(f.get("text", "")) + " " + " ".join(f.get("tags", []))) for f in need]
    vecs = _embed_batch(texts)
    if not vecs:
        return
    for f, v in zip(need, vecs):
        if v:
            f["vec"] = v
    _save_memories(frags)


def _cosine_lists(a, b):
    if not a or not b:
        return 0.0
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0 or nb == 0:
        return 0.0
    n = min(len(a), len(b))
    return sum(a[i] * b[i] for i in range(n)) / (na * nb)


_migrated = False


def _ensure_store():

    global _migrated
    if _migrated:
        return
    _migrated = True
    try:
        if os.path.isfile(_path(MEMORIES_FILE)) or os.path.isfile(_path(RESIDENT_FILE)):
            return
        legacy = _path(LEGACY_FILE)
        if not os.path.isfile(legacy):
            _save_resident({"facts": [], "rules": list(RESIDENT_RULES)})
            _save_memories([])
            return
        data = json.load(open(legacy, "r", encoding="utf-8"))
        items = data.get("memories", []) if isinstance(data, dict) else (data or [])
        facts, frags = [], []
        for it in items:
            if not isinstance(it, dict):
                continue
            s = (it.get("summary") or "").strip()
            if not s:
                continue
            imp = int(it.get("importance", 5))
            m = re.match(r"^\[On ([^\]]+)\]\s*(.*)$", s)
            if m:
                topic = m.group(1).strip().lower().replace(" ", "-")
                body = m.group(2).strip()
                tags = ["theme:" + topic, "emotion:neutral"]
            else:
                body, tags = s, ["theme:misc", "emotion:neutral"]
            if imp >= KEEP_MIN_IMPORTANCE:
                facts.append(body)
            else:
                frags.append(_new_fragment(body, tags, imp, it.get("ts")))
        facts = list(dict.fromkeys(facts))
        _save_resident({"facts": facts, "rules": list(RESIDENT_RULES)})
        _save_memories(frags)
        try:
            os.rename(legacy, _path(LEGACY_FILE + ".legacy"))
        except Exception:
            pass
        print(f"[memory] 迁移完成：常驻 {len(facts)} 条，情景片段 {len(frags)} 条", flush=True)
    except Exception as e:
        print(f"[memory] 迁移失败（忽略，下次重试）: {e}", flush=True)


def _save_resident(res):
    try:
        os.makedirs(MEM_DIR, exist_ok=True)
        with open(_path(RESIDENT_FILE), "w", encoding="utf-8") as f:
            json.dump(res, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        print(f"[memory] 常驻层保存失败: {e}")
        return False


def load_resident():
    _ensure_store()
    try:
        with open(_path(RESIDENT_FILE), "r", encoding="utf-8") as f:
            res = json.load(f)
        if not isinstance(res, dict):
            res = {}
        res.setdefault("facts", [])
        res.setdefault("rules", list(RESIDENT_RULES))
        return res
    except Exception:
        return {"facts": [], "rules": list(RESIDENT_RULES)}


def resident_prompt():

    res = load_resident()
    facts = [f for f in res.get("facts", []) if f and f.strip()]
    rules = res.get("rules") or RESIDENT_RULES
    lines = ["【Resident】", "（always true, treat as your own quiet background）"]
    for f in facts:
        lines.append("- " + f.strip())
    lines.append("")
    lines.append("【How you hold memory】")
    for r in rules:
        lines.append(r)
    return "\n".join(lines)


def _new_fragment(text, tags, importance, ts=None, mood=None):
    now = ts or datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    f = {
        "id": "f" + datetime.datetime.now().strftime("%Y%m%d%H%M%S") + str(abs(hash(text)) % 1000),
        "text": text.strip(),
        "tags": list(tags) if tags else ["theme:misc"],
        "ts": now,
        "importance": int(importance),
        "hits": 0,
        "vec": None,
    }
    if mood:
        f["mood"] = str(mood).strip()
    return f


def _save_memories(frags):
    try:
        os.makedirs(MEM_DIR, exist_ok=True)
        with open(_path(MEMORIES_FILE), "w", encoding="utf-8") as f:
            json.dump({"fragments": frags}, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        print(f"[memory] 情景片段保存失败: {e}")
        return False


def _bump_hits(texts):

    if not texts:
        return
    frags = load_memories()
    if not frags:
        return
    key_set = {t.strip() for t in texts if t and t.strip()}
    changed = False
    for f in frags:
        if (f.get("text") or "").strip() in key_set:
            f["hits"] = int(f.get("hits", 0)) + 1
            changed = True
    if changed:
        _save_memories(frags)


def load_memories():
    _ensure_store()
    try:
        with open(_path(MEMORIES_FILE), "r", encoding="utf-8") as f:
            data = json.load(f)
        frags = data.get("fragments", []) if isinstance(data, dict) else data
        return [f for f in frags if isinstance(f, dict) and (f.get("text") or "").strip()]
    except Exception:
        return []


def add_fragment(text, tags=None, importance=5, ts=None, mood=None):

    text = (text or "").strip()
    if not text:
        return False
    frags = load_memories()
    for f in frags:
        if f.get("text", "").strip() == text:
            f["importance"] = max(int(f.get("importance", 5)), int(importance))
            f["ts"] = ts or datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            f["hits"] = int(f.get("hits", 0))
            if mood:
                f["mood"] = str(mood).strip()
            _save_memories(frags)
            return True
    frags.append(_new_fragment(text, tags, importance, ts, mood))
    if len(frags) > MAX_FRAGMENTS:
        frags = _prune_to_limit(frags)
    _save_memories(frags)
    return True


def add(summary, importance=5, ts=None):
    return add_fragment(summary, None, importance, ts)


def load():

    frags = load_memories()
    for f in frags:
        f.setdefault("summary", f.get("text", ""))
    return frags


_TOKEN_RE = re.compile(r"[a-z0-9]+")
_CJK_RE = re.compile(r"[一-鿿]")


def _tokens(text):
    if not text:
        return []
    t = str(text).lower()
    toks = _TOKEN_RE.findall(t)
    toks += _CJK_RE.findall(t)
    return toks


def _tf_vector(text):

    c = Counter(_tokens(text))
    n = sum(c.values()) or 1
    return {w: (1.0 + math.log(c[w])) for w in c} if False else {w: c[w] / n for w in c}


def _frag_vector(frag):

    v = _tf_vector(frag.get("text", ""))
    for tag in (frag.get("tags") or []):
        v[("tag:" + str(tag).lower())] = v.get(("tag:" + str(tag).lower()), 0) + TAG_BOOST
    return v


def _cosine(a, b):
    if not a or not b:
        return 0.0
    if len(a) > len(b):
        a, b = b, a
    dot = 0.0
    for k, av in a.items():
        bv = b.get(k)
        if bv:
            dot += av * bv
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _tag_overlap(user_text, tags):

    if not tags:
        return 0.0
    ut = str(user_text).lower()
    if not ut.strip():
        return 0.0
    hits = 0
    for tag in tags:
        kw = str(tag).split(":", 1)[-1].lower().strip()
        if not kw:
            continue
        if kw in ut or ut in kw:
            hits += 1
            continue
        if str(tag).lower().startswith("emotion:"):
            tag_root = _EMO_WORD_TO_ROOT.get(kw)
            if tag_root:
                for uword in _MOOD_SYNONYMS.get(tag_root, set()):
                    if uword and uword in ut:
                        hits += 1
                        break
    return min(1.0, hits / max(1, len(tags)) * 1.5)


_MOOD_KEYS = {
    "happy":    ["开心", "高兴", "快乐", "喜欢", "哈哈", "可爱", "happy", "glad", "haha", "love"],
    "excited":  ["兴奋", "激动", "太棒", "好耶", "终于", "excited", "amazing", "awesome"],
    "shy":      ["害羞", "脸红", "不好意思", "shy", "blush", "embarrass"],
    "sad":      ["难过", "伤心", "悲伤", "难过死", "委屈", "哭", "哭了", "想哭", "沮丧", "低落", "郁闷", "寂寞", "想你", "抱歉", "sad", "lonely", "miss", "sorry", "upset", "depressed", "cry", "crying"],
    "curious":  ["好奇", "想知道", "为什么", "怎么", "curious", "wonder", "how come"],
    "surprised": ["真的吗", "不会吧", "居然", "惊讶", "surpris", "shock", "what"],
    "worried":  ["担心", "害怕", "紧张", "worry", "afraid", "nervous"],
    "concerned": ["担心你", "你还好吗", "注意身体", "care about you"],
    "playful":  ["开玩笑", "调皮", "逗", "playful", "kidding", "silly"],
    "bored":    ["无聊", "没意思", "bored"],
}

_MOOD_SYNONYMS = {
    "sad": {"难过", "伤心", "悲伤", "委屈", "沮丧", "低落", "郁闷", "想哭", "哭"},
    "happy": {"开心", "高兴", "快乐", "愉快", "喜悦", "幸福"},
    "excited": {"兴奋", "激动", "期待"},
    "worried": {"担心", "焦虑", "紧张", "害怕", "恐惧"},
    "shy": {"害羞", "脸红", "羞涩", "不好意思"},
    "curious": {"好奇", "想知道"},
    "surprised": {"惊讶", "震惊", "意外", "吃惊"},
    "bored": {"无聊", "没意思", "乏味"},
    "playful": {"调皮", "开玩笑", "逗"},
    "concerned": {"关心", "牵挂", "在意"},
}
_EMO_WORD_TO_ROOT = {}
for _root, _words in _MOOD_SYNONYMS.items():
    for _w in _words:
        _EMO_WORD_TO_ROOT[_w] = _root


def _detect_moods(user_text):

    t = str(user_text or "").lower()
    if not t.strip():
        return set()
    out = set()
    for mood, keys in _MOOD_KEYS.items():
        if any(k.lower() in t for k in keys):
            out.add(mood)
    return out


def _mood_match(user_moods, frag):

    m = (frag.get("mood") or "").strip().lower()
    if not m:
        for tag in (frag.get("tags") or []):
            tl = str(tag).lower()
            if tl.startswith("emotion:"):
                root = _EMO_WORD_TO_ROOT.get(tl.split(":", 1)[-1].strip())
                if root:
                    m = root
                    break
    if not m or not user_moods:
        return 0.0
    if m in user_moods:
        return 1.0
    return 1.0 if any(m == _EMO_WORD_TO_ROOT.get(u) for u in user_moods) else 0.0


def _age_days(ts):
    if not ts:
        return 0.0
    try:
        t = datetime.datetime.strptime(ts[:19], "%Y-%m-%d %H:%M:%S")
    except Exception:
        try:
            t = datetime.datetime.strptime(ts[:16], "%Y-%m-%d %H:%M")
        except Exception:
            return 0.0
    return max(0.0, (datetime.datetime.now() - t).total_seconds() / 86400.0)


def _recency_weight(age, half_life):
    return 0.5 ** (age / max(0.1, half_life))


def retrieve(user_text, force=False):

    cfg = _cfg_memory()
    half_life = float(cfg.get("half_life_days", DEFAULT_HALF_LIFE_DAYS))
    want_semantic = _embed_enabled()
    k = int(cfg.get("force_max_inject" if force else "max_inject",
                    FORCE_MAX_INJECT if force else MAX_INJECT))

    frags = load_memories()
    if not frags or not (user_text or "").strip():
        return []

    _ensure_embeddings(frags)
    frags_have_vec = any(isinstance(f.get("vec"), list) and f["vec"] for f in frags)
    use_semantic = want_semantic and frags_have_vec
    uvec = None
    if use_semantic:
        _uvecs = _embed_batch([user_text]) or []
        uvec = _uvecs[0] if _uvecs else None
    if use_semantic and not uvec:
        use_semantic = False

    if use_semantic:
        th = float(cfg.get("force_threshold" if force else "retrieval_threshold",
                           DEFAULT_FORCE_THRESHOLD if force else DEFAULT_RETRIEVAL_THRESHOLD))
    else:
        th = float(cfg.get("force_threshold_tfidf" if force else "retrieval_threshold_tfidf",
                           DEFAULT_FORCE_THRESHOLD_TFIDF if force else DEFAULT_RETRIEVAL_THRESHOLD_TFIDF))

    scored = []
    user_moods = _detect_moods(user_text)
    for f in frags:
        tov = _tag_overlap(user_text, f.get("tags"))
        fvec = f.get("vec") if (isinstance(f.get("vec"), list) and f["vec"]) else None
        if use_semantic and fvec and uvec:
            sim = _cosine_lists(uvec, fvec)
            combined = SEMANTIC_W * sim + TAG_W * tov
        else:
            sim = _cosine(_tf_vector(user_text), _frag_vector(f))
            combined = 0.6 * sim + 0.4 * tov
        combined += MOOD_W * _mood_match(user_moods, f)
        if combined <= 0:
            continue
        age = _age_days(f.get("ts"))
        rec = _recency_weight(age, half_life)
        gate_base = sim if (use_semantic and uvec and fvec) else combined
        gated = gate_base * (0.55 + 0.45 * rec)
        final = combined * (0.25 + 0.75 * rec) + 0.02 * int(f.get("hits", 0)) * rec
        if force:
            salience = int(f.get("importance", 5)) * rec
            score = combined * (1.0 + 0.5 * rec) + 0.15 * salience
            scored.append((f, score, combined))
        else:
            if gated < th:
                continue
            scored.append((f, final, gated))
    scored.sort(key=lambda x: x[1], reverse=True)

    if not force:
        if scored:
            keep = [scored[0]]
            if len(scored) > 1:
                c1, c2 = scored[0][2], scored[1][2]
                if c2 >= th and c2 >= TOP2_RATIO * c1:
                    keep.append(scored[1])
            scored = keep[:k]
    return [(f, s) for (f, s, _c) in scored][:k]


def recall_context(user_text, force=False):

    hits = retrieve(user_text, force=force)
    if not hits:
        return ""
    lines = ["【Recollection】",
             "Weave in ONLY if it fits the moment naturally; never recite these as a list."]
    for f, _ in hits:
        lines.append("- " + f.get("text", "").strip())
    try:
        _bump_hits([f.get("text", "") for f, _ in hits])
    except Exception:
        pass
    return "\n".join(lines)


FORCE_PHRASES = [
    "你还记得", "你记得吗", "你还记不记得", "上次那个", "之前那个",
    "我们之前", "我们上次", "记得我们", "以前我们", "你没忘吧",
    "do you remember", "remember when", "remember that", "do you recall",
    "last time we", "the other day", "you remember",
    "最近一次", "上一次", "之前为什么", "为什么难过", "为什么伤心",
    "是什么来着", "之前说过", "最近说过", "上次说", "之前聊过",
]


def is_force_recall(text):
    if not text:
        return False
    t = str(text).lower()
    return any(p.lower() in t for p in FORCE_PHRASES)


def recall_for_proactive():

    frags = load_memories()
    if not frags:
        return ""
    cfg = _cfg_memory()
    half_life = float(cfg.get("half_life_days", DEFAULT_HALF_LIFE_DAYS))
    best = None
    best_s = -1
    for f in frags:
        age = _age_days(f.get("ts"))
        rec = _recency_weight(age, half_life)
        s = 0.5 * int(f.get("importance", 5)) + 5 * rec
        if s > best_s:
            best_s, best = s, f
    return best.get("text", "").strip() if best else ""


def proactive_hint():

    frag = recall_for_proactive()
    if not frag:
        return ""
    return "【A memory you may use if it fits】\n- " + frag


def score_of(item, half_life, keep_min):

    imp = int(item.get("importance", 5))
    if imp >= keep_min:
        return 9999.0
    age = _age_days(item.get("ts", ""))
    decay = 0.5 ** (age / max(0.1, half_life))
    return imp * decay + 0.08 * int(item.get("hits", 0)) * decay


def _prune_to_limit(frags):
    cfg = _cfg_memory()
    half_life = float(cfg.get("half_life_days", DEFAULT_HALF_LIFE_DAYS))
    keep_min = int(cfg.get("keep_min_importance", KEEP_MIN_IMPORTANCE))
    scored = sorted(frags, key=lambda f: score_of(f, half_life, keep_min))
    return scored[-MAX_FRAGMENTS:]


def forget():

    cfg = _cfg_memory()
    half_life = float(cfg.get("half_life_days", DEFAULT_HALF_LIFE_DAYS))
    threshold = float(cfg.get("forget_score", DEFAULT_FORGET_SCORE))
    keep_min = int(cfg.get("keep_min_importance", KEEP_MIN_IMPORTANCE))

    frags = load_memories()
    if not frags:
        return 0, 0
    kept = [(score_of(f, half_life, keep_min), f) for f in frags]
    kept = [(s, f) for (s, f) in kept if s >= threshold]
    if len(kept) > MAX_FRAGMENTS:
        kept.sort(key=lambda x: x[0], reverse=True)
        kept = kept[:MAX_FRAGMENTS]
    kept_items = [f for (_, f) in kept]
    removed = len(frags) - len(kept_items)
    if removed > 0:
        print(f"[memory] 遗忘：删除 {removed} 条，保留 {len(kept_items)} 条", flush=True)
    _save_memories(kept_items)
    return len(kept_items), removed


SUMMARY_SYS_PROMPT = (
    "You ARE Neuro, a Live2D desktop pet on user's desktop. Write your OWN memory "
    "in FIRST PERSON - use I / me / my, never third person. "
    "user is 'user' (he/him).\n\n"
    "Human memory is small and lossy. You keep only the GIST of what mattered, "
    "never a transcript. Given one conversation, extract AT MOST 2 short impressions.\n\n"
    "Output: a JSON array only. No prose, no markdown fence. No code block.\n"
    "Each item: {\"fragment\": \"...\", \"tags\": [\"theme:...\", \"emotion:...\"], "
    "\"importance\": 1-10, \"mood\": \"...\"}\n\n"
    "MOOD: one word for HOW YOU felt during that conversation, from this closed set:\n"
    "  happy / excited / shy / sad / curious / surprised / worried / concerned / "
    "playful / bored / neutral.\n"
    "Pick the single dominant mood. This is the emotional signature of the memory, "
    "so a later similar mood can resurface it. Default to neutral if none stands out.\n\n"
    "FRAGMENT: ONE short sentence, at most 20 words, English, FIRST PERSON "
    "(\"I ...\", \"user and I ...\"). Keep the general impression only: what the "
    "conversation was about, how it felt. NEVER quote anything either of you said "
    "verbatim; never list details, filenames, numbers or step-by-step events. "
    "Never invent details absent from the conversation.\n\n"
    "TAGS: 1-3 keywords, each \"theme:<词>\" or \"emotion:<词>\".\n"
    "Use SHORT, searchable ROOT words so a later mention can match them:\n"
    "  theme examples: 旅行, 游戏, Minecraft, 猫, 工作压力, 高考, 历史, 音乐, 日常, 电脑操作\n"
    "  emotion examples: 开心, 温暖, 害羞, 好奇, 中性, 难过, 兴奋\n"
    "Rules: (a) theme keyword must be a bare root (e.g. use 旅行 NOT 旅行计划); "
    "(b) emotion keyword is one of the mood words above; "
    "(c) NO long phrases, NO sentences in tags. "
    "A later user line containing that root (or contained by it) will match.\n\n"
    "IMPORTANCE: 9-10 core identity / deep personal / long-running projects / "
    "standing rules (never forget). 7-8 substantial topic discussion, his goals, "
    "ongoing work. 4-6 light chat or one-off requests. Skip anything below 4.\n\n"
    "Prefer ONE item over two. Skip greetings, jokes and small talk entirely. "
    "If there is no substantial content, output []."
)


def _summary_call_with_deadline(body, api_url, api_key, deadline_s=20.0):
    import concurrent.futures

    def _do():
        req = urllib.request.Request(
            api_url, data=body,
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {api_key}"},
        )
        with urllib.request.urlopen(req, timeout=deadline_s) as resp:
            _buf = b""
            while True:
                _chunk = resp.read1(65536)
                if not _chunk:
                    break
                _buf += _chunk
            return json.loads(_buf.decode("utf-8"))

    ex = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    try:
        fut = ex.submit(_do)
        try:
            return fut.result(timeout=deadline_s)
        except concurrent.futures.TimeoutError:
            print(f"[memory] 总结请求超过 {deadline_s:.0f}s，放弃（改走原文兜底）", flush=True)
            return None
        except Exception as e:
            print(f"[memory] 总结请求失败（改走原文兜底）: {e}", flush=True)
            return None
    finally:
        ex.shutdown(wait=False, cancel_futures=True)


def summarize_dialogue(messages):

    if not messages or len(messages) < 2:
        print("[memory] 对话不足 2 条，跳过 LLM 总结（无实质内容可记）")
        return []

    cfg_all = _cfg_memory()
    llm = _load_full_cfg().get("llm") or {}

    api_key = llm.get("api_key", "")
    api_url = llm.get("upstream_url", "https://api.deepseek.com") + "/chat/completions"
    model = llm.get("model", "deepseek-chat")
    if not api_key:
        return []

    recent = messages[-60:]
    conv_lines = []
    for m in recent:
        role = m.get("role", "user")
        who = "user" if role == "user" else "Neuro"
        conv_lines.append(f"{who}: {m.get('content', '')}")
    conv = "\n".join(conv_lines)

    body = json.dumps({
        "model": model,
        "stream": False,
        "temperature": 1,
        "messages": [
            {"role": "system", "content": SUMMARY_SYS_PROMPT},
            {"role": "user", "content": f"Conversation:\n{conv}"},
        ],
    }).encode("utf-8")

    try:
        import neuro_server as ns
        _ok, _why = ns._upstream_slot(timeout=8.0)
    except Exception:
        _ok, _why = True, ""
    if not _ok:
        print(f"[memory] 总结跳过（{_why}），本轮不记（退出时会再试）", flush=True)
        return []

    _slot_taken = True
    try:
        data = _summary_call_with_deadline(body, api_url, api_key)
        if data is None:
            return []
        text = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
        s = text.find("[")
        e = text.rfind("]")
        if s < 0 or e < 0:
            return []
        arr = json.loads(text[s:e + 1])
        out = []
        for it in arr:
            if not isinstance(it, dict):
                continue
            frag = str(it.get("fragment") or it.get("summary") or "").strip()
            if not frag:
                continue
            imp = max(1, min(10, int(it.get("importance", 5))))
            if imp < 4:
                continue
            tags = it.get("tags") or []
            if isinstance(tags, str):
                tags = [tags]
            tags = [str(t).strip() for t in tags if str(t).strip()][:4] or ["theme:misc"]
            mood = str(it.get("mood") or "").strip()
            _valid_moods = {"happy", "excited", "shy", "sad", "curious", "surprised",
                            "worried", "concerned", "playful", "bored", "neutral"}
            if mood.lower() not in _valid_moods:
                mood = ""
            out.append({"text": frag, "tags": tags, "importance": imp, "mood": mood})
        return out
    except Exception as e:
        print(f"[memory] 总结失败: {e}")
        return []
    finally:
        if _slot_taken:
            try:
                import neuro_server as ns
                ns._release_slot()
            except Exception:
                pass


def session_end(messages):

    n_visual_removed = drop_vision_ephemeral()
    extracted = summarize_dialogue(messages)[:MAX_PER_SESSION]
    n = 0
    added_texts = []
    for it in extracted:
        text = trim_fragment(str(it.get("text") or ""))
        if text and add_fragment(text, it.get("tags"), it.get("importance", 5),
                                 mood=it.get("mood")):
            n += 1
            added_texts.append(text)
    kept, removed = forget()
    wk = maybe_weekly_maintenance()
    removed += wk[1] if wk else 0
    print(f"[memory] 本轮留 {n} 条印象；视觉临时清理 {n_visual_removed} 条；"
          f"当前共 {kept} 条（上限 {MAX_FRAGMENTS}）", flush=True)
    try:
        import consolidation as _co
        _co.form_habits()
        _co.generate_tomorrow()
    except Exception:
        pass
    return n + n_visual_removed, kept, removed, added_texts


def drop_vision_ephemeral():

    try:
        frags = load_memories()
        if not frags:
            return 0
        kept_items = [f for f in frags if "vision:ephemeral" not in (f.get("tags") or [])]
        removed = len(frags) - len(kept_items)
        if removed > 0:
            _save_memories(kept_items)
            print(f"[memory] 退出：清理视觉临时记忆 {removed} 条", flush=True)
        return removed
    except Exception as e:
        print(f"[memory] 视觉临时清理失败: {e}", flush=True)
        return 0


WEEKLY_INTERVAL_DAYS = 7.0
WEEKLY_FORGET_SCORE = 0.8
WEEKLY_MAX_AGE_DAYS = 14.0
WEEKLY_HALF_LIFE = 3.0


def _read_last_forget():
    try:
        with open(_path(LAST_FORGET_FILE), "r", encoding="utf-8") as f:
            return float(f.read().strip())
    except Exception:
        return 0.0


def _write_last_forget(ts):
    try:
        with open(_path(LAST_FORGET_FILE), "w", encoding="utf-8") as f:
            f.write(str(ts))
    except Exception:
        pass


def maybe_weekly_maintenance(force=False):
    now = datetime.datetime.now().timestamp()
    last = _read_last_forget()
    if not force and (now - last) < WEEKLY_INTERVAL_DAYS * 86400:
        return None
    res = weekly_maintenance()
    _write_last_forget(now)
    return res


def weekly_maintenance():
    frags = load_memories()
    if not frags:
        return 0, 0
    half_life = WEEKLY_HALF_LIFE
    threshold = WEEKLY_FORGET_SCORE
    keep_min = KEEP_MIN_IMPORTANCE
    kept, removed = [], 0
    for f in frags:
        sc = score_of(f, half_life, keep_min)
        age = _age_days(f.get("ts", ""))
        imp = int(f.get("importance", 5))
        if sc < threshold or (age > WEEKLY_MAX_AGE_DAYS and imp < 7):
            removed += 1
        else:
            kept.append(f)
    kept = simplify_memories(kept)
    _save_memories(kept)
    return len(kept), removed


def _text_overlap_ratio(a, b):

    def toks(s):
        return set(re.findall(r"[\w\u4e00-\u9fff]+", str(s or "").lower()))
    ta, tb = toks(a), toks(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / float(min(len(ta), len(tb)))


def _inherit_meta(new_text, items):

    best, best_ratio = None, 0.0
    for it in items:
        r = _text_overlap_ratio(new_text, it.get("text", ""))
        if r > best_ratio:
            best, best_ratio = it, r
    if best is None or best_ratio < 0.5:
        return None
    return best


def simplify_memories(items):
    if not items:
        return items
    llm = _cfg_memory()
    llm = _load_full_cfg().get("llm") or {}
    api_key = llm.get("api_key", "")
    if not api_key:
        return items
    listing = "\n".join(
        f"{i+1}. [imp {int(it.get('importance', 5))}] {it.get('text', '')}"
        for i, it in enumerate(items)
    )
    sys = (
        "You condense a desktop pet's long-term memory into the SHORTEST form. "
        "Rules: ONE tight sentence per item, at most 20 words, in English. "
        "Keep the tags. Merge near-duplicates. Keep the importance. "
        'Output a JSON array only: [{"text":"...","tags":[...],"importance":N}, ...]'
    )
    api_url = llm.get("upstream_url", "https://api.deepseek.com") + "/chat/completions"
    model = llm.get("model", "deepseek-chat")
    body = json.dumps({
        "model": model, "stream": False, "temperature": 1,
        "messages": [
            {"role": "system", "content": sys},
            {"role": "user", "content": f"Current memory list:\n{listing}"},
        ],
    }).encode("utf-8")
    try:
        import neuro_server as ns
        _ok, _why = ns._upstream_slot(timeout=8.0)
    except Exception:
        _ok, _why = True, ""
    if not _ok:
        return items
    _slot = True
    try:
        req = urllib.request.Request(
            api_url, data=body,
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {api_key}"},
        )
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        text = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
        a = text.find("[")
        b = text.rfind("]")
        if a < 0 or b < 0:
            return items
        arr = json.loads(text[a:b + 1])
        out = []
        for it in arr:
            if not isinstance(it, dict) or not it.get("text"):
                continue
            raw = it.get("importance", 5)
            try:
                imp = max(1, min(10, int(raw)))
            except Exception:
                imp = 5
            tags = it.get("tags") or ["theme:misc"]
            if isinstance(tags, str):
                tags = [tags]
            _src = _inherit_meta(it["text"], items)
            _now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            out.append({"id": "f" + datetime.datetime.now().strftime("%Y%m%d%H%M%S")
                        + str(abs(hash(it["text"])) % 1000),
                        "text": str(it["text"]).strip(),
                        "tags": [str(t).strip() for t in tags if str(t).strip()][:4],
                        "ts": (_src.get("ts") if (_src and _src.get("ts")) else _now),
                        "importance": imp,
                        "hits": (int(_src.get("hits", 0)) if _src else 0),
                        "vec": None,
                        "simplified_at": _now})
        print(f"[memory] 周度简化：{len(items)} 条 -> 压缩为 {len(out)} 条")
        return out if out else items
    except Exception as ex:
        print(f"[memory] 周度简化失败（保留原样）: {ex}")
        return items
    finally:
        if _slot:
            try:
                import neuro_server as ns
                ns._release_slot()
            except Exception:
                pass


if __name__ == "__main__":
    kept, removed = forget()
    print(f"整理完成：保留 {kept} 条，删除 {removed} 条")
    print(f"记忆目录：{MEM_DIR}")
