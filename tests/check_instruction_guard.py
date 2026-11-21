# -*- coding: utf-8 -*-
"""check_instruction_guard.py — 指令保护窗的误判回归。
用法：python tests/check_instruction_guard.py"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

import cognition  # noqa: E402

fails = 0


def check(text, want):
    global fails
    cognition.set_instruction_guard("", ttl_s=0)
    got = cognition.maybe_start_instruction_guard(text)
    if got == want:
        print(f"  PASS {text!r} -> {got}")
    else:
        fails += 1
        print(f"  FAIL {text!r} -> {got}（期望 {want}）")


print("[1] 真指令：应开窗")
for t in ["帮我写一个贪吃蛇", "写一个冒泡排序", "打开 D 盘的 GAME 文件夹",
          "please fix the build", "修一下这个 bug", "run the tests"]:
    check(t, True)

print("[2] 感慨/评价/疑问：不该开窗")
for t in ["我觉得写作很有意思", "这个改动挺好看", "你会写吗", "写作真难啊",
          "what do you think about writing", "写的不错"]:
    check(t, False)

print("[3] 太短：不判定")
check("写", False)

print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(0 if fails == 0 else 1)
