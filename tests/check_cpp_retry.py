import os
import io
import json
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))
import agent_bridge as ab


PASS = 0
FAIL = 0


def ck(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  \u2713 " + name)
    else:
        FAIL += 1
        print("  \u2717 FAIL: " + name + (f"  ({extra})" if extra else ""))


print("\n[A] 写代码意图识别（_wants_cpp）")
for t, want in [
    ("用键盘写", True),
    ("我就让你用键盘写，不是让你说出来", True),
    ("写个贪吃蛇", True),
    ("写代码", True),
    ("写程序", True),
    ("写个C++程序", True),
    ("帮我看看这段代码", False),
    ("打开D盘", False),
    ("今天天气不错", False),
]:
    ck(f"_wants_cpp({t!r}) = {want}", ab._wants_cpp(t) == want)


print("\n[B] 写代码强制重问：裸代码不念、重问后代码进编辑器")


def make_seq(first_round, retry_round):

    seq = iter([first_round, retry_round])

    def fake_stream(cfg, messages, retries=4, max_tokens_override=None):
        return iter(next(seq))

    return fake_stream


ab.llm_stream = make_seq(
    [("emo", "neutral"), ("txt", "Sure, here it is.\nX = (SHORT)(x * 2);")],
    [("cpp", "#include <iostream>\nint main(){ return 0; }")],
)
ev = list(ab.chat_stream({"messages": [{"role": "user", "content": "用键盘写个贪吃蛇"}]}))

room_cmds = [e for e in ev if "room_cmd" in e]
choices_txt = "".join(
    (e.get("choices") or [{}])[0].get("delta", {}).get("content") or ""
    for e in ev
)
emotions = [e for e in ev if "emotion" in e]

ck("重问后下发了 cpp_set_code（代码进编辑器）",
   any(e["room_cmd"].get("op") == "cpp_set_code" for e in room_cmds))
ck("代码内容正确写入 room_cmd",
   any("#include <iostream>" in e["room_cmd"].get("code", "") for e in room_cmds))
ck("代码绝不出现在台词（choices）里", "SHORT" not in choices_txt and "include" not in choices_txt,
   choices_txt[:80])
ck("第一轮谎话不播（choices 为空）", choices_txt == "", choices_txt[:80])
ck("情绪事件仍正常下发", len(emotions) >= 1)

mirror = ab._read_cpp_mirror()
ck("代码镜像已落盘（cpp_get_code 能读到）",
   isinstance(mirror, dict) and mirror.get("ok") and "#include" in str(mirror.get("code_with_line_numbers", "")),
   str(mirror)[:80])

print("\n===== " + str(PASS) + " passed, " + str(FAIL) + " failed =====")
sys.exit(1 if FAIL else 0)
