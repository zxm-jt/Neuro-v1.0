# -*- coding: utf-8 -*-
import re
import time

_EXAMPLE_REPLY_RE = re.compile(r"^\s*Neuro:\s*(.+?)\s*$", re.M)
_SCENARIO_RE = re.compile(r"^SCENARIO\s+\d+:", re.M)
_EXAMPLE_HEAD_RE = re.compile(r"^###\s+\d+\.\s*(.+?)\s*$", re.M)
_SPEAKER_RE = re.compile(r"^([A-Za-z_\-{][\w\-{}]{0,23})\s*:\s*(.*)$")
_EMO_TAG_RE = re.compile(r"[\[【]\s*[A-Za-z0-9_\u4e00-\u9fff \-]{1,40}?\s*[\]】]")


def _is_user_line(line):
    m = _SPEAKER_RE.match(line or "")
    return bool(m) and m.group(1).lower() != "neuro"

REUSE_THRESHOLD = 0.72

_MIN_EXAMPLE_LEN = 12

_CACHE = {"text": "", "items": [], "at": 0.0}


def _strip_tags(text):

    if not text:
        return text
    out = _EMO_TAG_RE.sub('', text)
    out = re.sub(r'\s+([,;:.!?])', r'\1', out)
    out = re.sub(r'[ \t]{2,}', ' ', out)
    return out.strip()


def _example_section(system_prompt):

    if not system_prompt:
        return ""
    idx = system_prompt.find("EXAMPLE DIALOGUES")
    if idx < 0:
        idx = system_prompt.find("EXAMPLE CONVERSATIONS")
    if idx < 0:
        return ""
    seg = system_prompt[idx:]
    cut = seg.find("HOW TO LEARN FROM EXAMPLES")
    if cut > 0:
        seg = seg[:cut]
    return seg


def extract_example_replies(system_prompt):

    seg = _example_section(system_prompt)
    if not seg:
        return []
    items = []
    lines = seg.split("\n")
    i = 0
    while i < len(lines):
        st = lines[i].strip()
        if st.startswith("Neuro:"):
            buf = [st[len("Neuro:"):].strip()]
            i += 1
            while i < len(lines):
                nxt = lines[i].strip()
                if (not nxt) or nxt.startswith("---") or _is_user_line(nxt):
                    break
                if nxt.startswith("###"):
                    break
                if nxt.startswith("Neuro:"):
                    buf.append(nxt[len("Neuro:"):].strip())
                    i += 1
                    continue
                buf.append(nxt)
                i += 1
            t = re.sub(r"\s+", " ", " ".join(buf)).strip()
            t = _strip_tags(t)
            if len(t) >= _MIN_EXAMPLE_LEN:
                items.append(t)
            continue
        i += 1
    return items


def _norm(text):
    return re.sub(r"[^a-z0-9\s']", "", str(text or "").lower()).strip()


def _similarity(a, b):

    na, nb = _norm(a), _norm(b)
    if not na or not nb:
        return 0.0
    sa, sb = set(na.split()), set(nb.split())
    jaccard = 0.0
    if sa and sb:
        inter = len(sa & sb)
        union = len(sa | sb)
        jaccard = inter / float(union) if union else 0.0
    seq = 0.0
    try:
        import difflib
        seq = difflib.SequenceMatcher(None, na.split(), nb.split()).ratio()
    except Exception:
        pass
    return max(jaccard, seq)


def check_reuse(text, examples=None):

    t = str(text or "").strip()
    if len(t) < _MIN_EXAMPLE_LEN:
        return False, 0.0, None
    if examples is None:
        examples = _get_examples()
    best = 0.0
    best_item = None
    for ex in examples:
        sim = _similarity(t, ex)
        if sim > best:
            best = sim
            best_item = ex
    return (best >= REUSE_THRESHOLD), best, best_item


def looks_reused(text, examples=None):

    return check_reuse(text, examples)[0]


def _get_examples():

    try:
        import neuro_server as ns
        sp = getattr(ns, "_SYSTEM_PROMPT_CACHE", None)
        if sp is None:
            cfg = getattr(ns, "_cfg_llm", None)
            sp = ""
            if callable(cfg):
                try:
                    sp = cfg("system_prompt", "") or ""
                except Exception:
                    sp = ""
        now = time.time()
        if _CACHE["text"] != sp or now - _CACHE["at"] > 30.0:
            _CACHE["text"] = sp
            _CACHE["items"] = extract_example_replies(sp)
            _CACHE["at"] = now
        return _CACHE["items"]
    except Exception:
        return []


def set_system_prompt_cache(sp):

    _CACHE["text"] = sp or ""
    _CACHE["items"] = extract_example_replies(sp or "")
    _CACHE["at"] = time.time()
    return len(_CACHE["items"])


_EXAMPLE_CMD_RE = re.compile(r"^user://s*(.+?)//s*$", re.M)


def extract_example_pairs(system_prompt):

    seg = _example_section(system_prompt)
    if not seg:
        return []
    pairs = []
    lines = seg.split("\n")
    i = 0
    while i < len(lines):
        st = lines[i].strip()
        _sp_m = _SPEAKER_RE.match(st)
        if _sp_m and _sp_m.group(1).lower() != "neuro":
            buf = [_sp_m.group(2).strip()]
            i += 1
            while i < len(lines):
                nxt = lines[i].strip()
                if (not nxt) or nxt.startswith("---") or nxt.startswith("Neuro:"):
                    break
                if nxt.startswith("###"):
                    break
                buf.append(nxt)
                i += 1
            cmd_text = re.sub(r"\s+", " ", " ".join(buf)).strip()
            reply = ""
            j = i
            while j < len(lines):
                nxt = lines[j].strip()
                if nxt.startswith("Neuro:"):
                    rbuf = [nxt[len("Neuro:"):].strip()]
                    j += 1
                    while j < len(lines):
                        n2 = lines[j].strip()
                        if (not n2) or n2.startswith("---") or _is_user_line(n2):
                            break
                        if n2.startswith("###"):
                            break
                        rbuf.append(n2)
                        j += 1
                    reply = re.sub(r"\s+", " ", " ".join(rbuf)).strip()
                    reply = _strip_tags(reply)
                    i = j
                    break
                if nxt.startswith("---") or nxt.startswith("###"):
                    break
                j += 1
            if cmd_text:
                pairs.append((cmd_text, reply))
            continue
        i += 1
    return pairs


def find_colliding_example(user_text, system_prompt, threshold=0.80):

    u = _norm(user_text)
    if len(u) < 12:
        return False, None
    for cmd_text, _reply in extract_example_pairs(system_prompt):
        c = _norm(cmd_text)
        if not c:
            continue
        if u == c:
            return True, cmd_text
        try:
            import difflib
            if difflib.SequenceMatcher(None, u, c).ratio() >= threshold:
                return True, cmd_text
        except Exception:
            pass
    return False, None


def strip_example_from_prompt(system_prompt, cmd_text):

    if not system_prompt or not cmd_text:
        return system_prompt, False
    idx = system_prompt.find("EXAMPLE DIALOGUES")
    if idx < 0:
        idx = system_prompt.find("EXAMPLE CONVERSATIONS")
    if idx < 0:
        return system_prompt, False
    head = system_prompt[:idx]
    seg = system_prompt[idx:]
    pos = seg.find(cmd_text)
    if pos < 0:
        return system_prompt, False

    def _prev_block_head(upto):

        h3 = seg.rfind("\n### ", 0, upto)
        sc = seg.rfind("\nSCENARIO ", 0, upto)
        if h3 < 0 and sc < 0:
            return -1
        return max(h3, sc)

    def _next_block_head(frm):

        h3 = seg.find("\n### ", frm)
        sc = seg.find("\nSCENARIO ", frm)
        if h3 < 0 and sc < 0:
            return -1
        return min(x for x in (h3, sc) if x >= 0)

    block_start = _prev_block_head(pos)
    if block_start < 0:
        block_start = 0
    else:
        block_start += 1
    nxt = _next_block_head(pos)
    block_end = len(seg) if nxt < 0 else nxt
    new_seg = seg[:block_start] + seg[block_end:]
    return head + new_seg, True
