# -*- coding: utf-8 -*-
"""check_memory_trim.py — 记忆片段不能"半截断在词中间"。"""
import os
import sys

BACKEND = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend")
sys.path.insert(0, BACKEND)

import memory_system as ms  # noqa: E402

fails = 0


def ck(name, cond, extra=""):
    global fails
    if cond:
        print(f"  PASS {name}")
    else:
        fails += 1
        print(f"  FAIL {name}  {extra}")


bad = ("I helped user think through late chat-room letters and syncing subtitles "
       "from one pink source, maybe testing duplicate removals of old lines")
out = ms.trim_fragment(bad, 120)
print("  原文长度", len(bad), "→", len(out), repr(out[-24:]))
ck("不超上限", len(out) <= 120, len(out))
ck("不在词中间切断（结尾不是半个词）", out.endswith("…") or out.endswith((".", "!", "?")),
   out[-8:])
ck("保留了完整单词（没有 're' 这种残片）", not out.rstrip("…").endswith(("duplicate re", "duplica")))
ck("是原句的前缀（除了省略号）", bad.startswith(out.rstrip("…")))

short = "user and I talked about the chat room."
ck("短句原样返回", ms.trim_fragment(short, 120) == short)

sentence = ("I spent a long while helping user debug the subtitle pipeline. "
            "Then we kept going for another twenty minutes about the queue and the tail sentence.")
out2 = ms.trim_fragment(sentence, 120)
ck("优先在句末收（有句号结尾）", out2.endswith("."), out2[-30:])
ck("句末截断不超上限", len(out2) <= 120, len(out2))

long1 = ("I spent a long while helping user debug the subtitle pipeline and we finally "
         "found that the queue was dropping the tail sentence then we stopped for tea")
out3 = ms.trim_fragment(long1, 120)
ck("无句末时退到词边界（省略号）", out3.endswith("…"), out3[-20:])

print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(0 if fails == 0 else 1)
