# -*- coding: utf-8 -*-
"""check_utterance_hold.py —— 验证 C5：「话没说完就先别接」的判据与拼接。
用法："""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

import neuro_server as ns  # noqa: E402

fails = 0


def check(name, cond, extra=""):
    global fails
    if cond:
        print(f"  PASS {name}")
    else:
        fails += 1
        print(f"  FAIL {name}  {extra}")


print("[1] 明确没说完：必须暂存")
for t in ["我想说，", "然后", "那个", "and", "but I was", "it is", "...", "我还没说完…", "因为"]:
    check(f"{t!r} → 未完成", ns._looks_unfinished_utterance(t) is True)

print("[2] 明确说完了：必须立刻上送")
for t in ["好的。", "I think so.", "我想吃冰淇淋", "hello there", "行！", "OK?", "明白了"]:
    check(f"{t!r} → 已完成", ns._looks_unfinished_utterance(t) is False)

print("[3] 空文本 / 空白：不暂存")
for t in ["", "   ", None]:
    check(f"{t!r} → False", ns._looks_unfinished_utterance(t) is False)

print("[4] 拼接规则")
check("中文直拼", ns._merge_utterance_text("我想说，", "其实") == "我想说，其实",
      ns._merge_utterance_text("我想说，", "其实"))
check("中文直拼（无标点）", ns._merge_utterance_text("我想说", "其实") == "我想说其实",
      ns._merge_utterance_text("我想说", "其实"))
check("英文补空格", ns._merge_utterance_text("I was going", "to ask") == "I was going to ask",
      ns._merge_utterance_text("I was going", "to ask"))
check("空 a → 原样返回 b", ns._merge_utterance_text("", "hello") == "hello")
check("空 b → 原样返回 a", ns._merge_utterance_text("hello", "") == "hello")

print('[5] 合并后再判定：拼完就"说完了"')
merged = ns._merge_utterance_text("I was going", "to ask you something.")
check("拼完 = 完成", ns._looks_unfinished_utterance(merged) is False, merged)
merged2 = ns._merge_utterance_text("我想说，", "其实我不想去。")
check("中文拼完 = 完成", ns._looks_unfinished_utterance(merged2) is False, merged2)

print("[6] 后端暂存默认关闭（前端 asr-processor 已做同一件事，两边都扣会叠加延迟）")
check("config 未配 backend_hold_ms → 0", ns._cfg_backend_hold_ms() == 0,
      str(ns._cfg_backend_hold_ms()))

print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(0 if fails == 0 else 1)
