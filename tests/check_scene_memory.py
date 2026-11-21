# -*- coding: utf-8 -*-
"""check_scene_memory.py — "同一处境再出现时想起上次的感觉"（不需要起服务）。"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import numpy as np  # noqa: E402
from flybridge.assoc import AssocMemory  # noqa: E402
from flybridge.encoder import PerceptEncoder  # noqa: E402

fails = 0


def ck(name, cond, extra=""):
    global fails
    if cond:
        print(f"  PASS {name}")
    else:
        fails += 1
        print(f"  FAIL {name}  {extra}")


N_KC = 4064
enc = PerceptEncoder(N_KC, k_active=160)
assoc = AssocMemory(np.arange(N_KC), np.arange(64))

A = "user opened the settings window with a table of options"
B = "a code editor with many files open"

kA = np.zeros(N_KC, dtype=np.float32); kA[enc.text_to_kc(A)] = 1.0
kB = np.zeros(N_KC, dtype=np.float32); kB[enc.text_to_kc(B)] = 1.0
ck("A/B 的 KC 重叠接近随机水平", float((kA * kB).sum()) / max(1.0, kA.sum()) < 0.25, float((kA * kB).sum()))

target = np.zeros(7, dtype=np.float32)
target[0] = 0.9
target[1] = 0.4
for _ in range(5):
    assoc.write(kA, target, salience=1.0, gate=1.0)

rA = np.asarray(assoc.recall(kA)["affect"], dtype=np.float32)
rB = np.asarray(assoc.recall(kB)["affect"], dtype=np.float32)
ck("处境 A 回忆起正效价", rA[0] > 0.3, rA)
ck("无关处境 B 的回忆显著更弱", abs(rB[0]) < 0.35, rB)
ck("A 的回忆至少是 B 的 2.5 倍", float(np.linalg.norm(rA)) > float(np.linalg.norm(rB)) * 2.5,
   (float(np.linalg.norm(rA)), float(np.linalg.norm(rB))))

before = enc.to_kc(enc.encode(A))
enc.learn(A, np.r_[target[:4], np.zeros(60)], +1.0)
after = enc.to_kc(enc.encode(A))
ck("学习后同句仍然自洽（同一次调用内）", np.array_equal(after, enc.to_kc(enc.encode(A))))

print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(0 if fails == 0 else 1)
