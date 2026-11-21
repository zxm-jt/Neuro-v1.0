import os
import re
import sys
import json
import datetime
import urllib.request

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BACKEND_DIR)
def _resolve_mem():
    return os.path.join(PROJECT_ROOT, "memory", "text_database.txt")


MEM_FILE = _resolve_mem()
CONFIG_FILE = os.path.join(PROJECT_ROOT, "config.json")

MANUAL_MARK = "# ===== 手动设定"
AUTO_MARK = "# ===== 自动记忆"

_FILLER = {
    "嗯", "嗯嗯", "哦", "啊", "诶", "好", "好的", "好哒", "行", "可以", "对", "是的",
    "嗯哼", "哈哈", "哈哈哈", "呵呵", "呜", "呜呜", "OK", "ok", "Ok", "知道", "知道了",
    "了解", "收到", "在吗", "在的", "哦哦", "额", "呃", "唔", "呀", "喂", "哎",
}


def load_config():
    try:
        try:
            import secret_store
            return secret_store.load_config(CONFIG_FILE)
        except Exception:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        print(f"[warn] 读取 config.json 失败: {e}")
        return {}


def split_sections(text):

    if AUTO_MARK not in text:
        return text.rstrip() + "\n", ""
    idx = text.index(AUTO_MARK)
    manual = text[:idx].rstrip()
    rest = text[idx + len(AUTO_MARK):]
    nl = rest.find("\n")
    auto = rest[nl + 1:] if nl != -1 else ""
    auto_lines = []
    for ln in auto.splitlines():
        s = ln.strip()
        if not s:
            continue
        if s.startswith("#") and ("由「记忆提炼工具」" in s or "暂无" in s or "维护" in s):
            continue
        auto_lines.append(ln)
    return manual.rstrip() + "\n", "\n".join(auto_lines).strip()


def call_deepseek(cfg, auto_text):
    key = cfg.get("llm", {}).get("api_key", "")
    api_url = cfg.get("llm", {}).get("api_url", "https://api.deepseek.com/v1").rstrip("/")
    model = cfg.get("llm", {}).get("model", "deepseek-chat")
    if not key or key.startswith("sk-你的") or "占位" in key:
        return None
    system = (
        "你是一个记忆提炼器。下面是一段桌宠与用户的对话记录（用户原话，可能含噪声/重复/口语）。"
        "请提炼出关于【用户】的、跨会话仍然成立的稳定事实，供下次对话参考。\n"
        "要求：\n"
        "1. 只输出中文条列式，每条以「- 」开头，简洁（≤25字）。\n"
        "2. 分为三类，用标题行标出：用户画像 / 对Neuro的偏好 / 未竟话题。\n"
        "3. 丢弃闲聊语气词、重复、无意义短句；合并同类；不要编造未提及的信息。\n"
        "4. 不要输出任何解释、不要使用括号心情提示。"
    )
    user = "待提炼的对话记录：\n" + auto_text
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0.2,
        "stream": False,
    }
    req = urllib.request.Request(
        api_url + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data["choices"][0]["message"]["content"].strip()
    except Exception as e:
        print(f"[warn] DeepSeek 提炼失败，改用规则去重: {e}")
        return None


def heuristic_distill(auto_text):

    lines = [ln.strip() for ln in auto_text.splitlines() if ln.strip()]
    seen = set()
    out = []
    for ln in lines:
        t = ln.lstrip("- ").strip()
        t = re.sub(r"^\[\d{4}-\d{2}-\d{2}.*?\]", "", t).strip()
        if len(t) < 5:
            continue
        if t in _FILLER:
            continue
        if not re.search(r"[一-鿿a-zA-Z]", t):
            continue
        if t in seen:
            continue
        seen.add(t)
        out.append("- " + t)
    res = "用户画像：\n" + "\n".join(out) if out else "（暂无有效记忆）"
    return res


def condense_auto(auto_text):

    lines = [ln.strip() for ln in auto_text.splitlines() if ln.strip()]
    out = []
    seen = set()
    for ln in lines:
        if ln.startswith("#"):
            continue
        m = re.match(r"^\[(\d{4}-\d{2}-\d{2}[ \d:]*)\]\s*(.*)$", ln)
        if m:
            ts, body = m.group(1)[:10], m.group(2).strip()
        else:
            ts, body = "", ln
        body = body.lstrip("- ").strip()
        if len(body) < 5 or body in _FILLER:
            continue
        if not re.search(r"[一-鿿a-zA-Z]", body):
            continue
        if body in seen:
            continue
        seen.add(body)
        out.append(f"- {body}")
    return "\n".join(out)


def main():
    print(f"[distill] 读取记忆文件: {MEM_FILE}")
    with open(MEM_FILE, "r", encoding="utf-8") as f:
        raw = f.read()

    manual, auto = split_sections(raw)
    condensed = condense_auto(auto)
    if not condensed.strip():
        print("[distill] 自动记忆区为空，无需提炼。先和她多聊几句吧。")
        return

    cfg = load_config()
    distilled = call_deepseek(cfg, condensed)
    if distilled is None:
        distilled = "（未配置DeepSeek key，使用规则去重）\n" + condense_auto(auto)

    today = datetime.date.today().isoformat()
    new_auto = f"{AUTO_MARK}\n# 最近提炼于 {today}（由记忆提炼工具生成，勿手动改）\n{distilled}\n"

    with open(MEM_FILE, "w", encoding="utf-8") as f:
        f.write(manual.rstrip() + "\n\n")
        f.write(new_auto)
        f.write(f"\n# ===== 原始对话归档（{today}，供追溯）=====\n")
        f.write(condensed + "\n")

    print(f"[distill] 完成。提炼出 {distilled.count(chr(10))+1} 行记忆，已写回 text_database.txt")
    print("=" * 40)
    print(distilled)
    print("=" * 40)


if __name__ == "__main__":
    main()
