# -*- coding: utf-8 -*-
"""check_memory_fixes.py —— 验证记忆系统的两个致命修复（B6 / B7）。
用法："""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

import memory_system as ms  # noqa: E402

fails = 0


def check(name, cond, extra=""):
    global fails
    if cond:
        print(f"  PASS {name}")
    else:
        fails += 1
        print(f"  FAIL {name}  {extra}")


print("[1] B6：embedding 失败时 retrieve() 必须降级而不是崩")

_frags = [
    {"id": "a", "text": "user likes building desktop pets", "tags": ["theme:桌宠"],
     "ts": "2026-11-01 10:00:00", "importance": 7, "hits": 2, "vec": [0.1, 0.2, 0.3]},
    {"id": "b", "text": "user is preparing for the gaokao", "tags": ["theme:学业"],
     "ts": "2026-11-02 10:00:00", "importance": 8, "hits": 0, "vec": [0.3, 0.1, 0.2]},
]
ms.load_memories = lambda: list(_frags)
ms._cfg_memory = lambda: {"embeddings": {"enabled": True}, "retrieval_threshold_tfidf": 0.0}
ms._embed_enabled = lambda: True
ms._embed_batch = lambda texts: None
ms._ensure_embeddings = lambda frags: None

try:
    got = ms.retrieve("desktop pet project", force=False)
    check("retrieve 没抛异常", True)
    check("降级后仍能返回结果列表", isinstance(got, list), repr(got))
except Exception as e:  # noqa: BLE001
    check("retrieve 没抛异常", False, f"{type(e).__name__}: {e}")

print("[2] B7：周度简化必须继承前身的 ts / hits")

_src = [
    {"id": "x", "text": "user built a live2d desktop pet with voice chat",
     "tags": ["theme:桌宠"], "ts": "2026-10-01 09:00:00", "importance": 7, "hits": 5},
    {"id": "y", "text": "weather was nice on the weekend",
     "tags": ["theme:日常"], "ts": "2026-11-10 09:00:00", "importance": 4, "hits": 1},
]
hit = ms._inherit_meta("user made a live2d desktop pet with voice chat", _src)
check("能找回前身", hit is not None and hit["id"] == "x", repr(hit and hit.get("id")))
if hit:
    check("前身 ts 是 10-01（不是今天）", hit["ts"].startswith("2026-10-01"), hit["ts"])
    check("前身 hits=5", int(hit["hits"]) == 5, str(hit["hits"]))

check("完全不相关的文本不应误认前身",
      ms._inherit_meta("zzz qqq unrelated", _src) is None)

print("[3] 词面重合度基本行为")
check("同一句 ≈1.0", ms._text_overlap_ratio("hello world", "hello world") > 0.99)
check("完全无关 =0", ms._text_overlap_ratio("abc", "xyz") == 0.0)

print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(0 if fails == 0 else 1)
