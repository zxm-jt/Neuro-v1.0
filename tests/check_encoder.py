# -*- coding: utf-8 -*-
"""check_encoder.py — 感知编码器：同一说法 → 同一群 KC；不同说法 → 不同群；可学习。
用法：python tests/check_encoder.py"""
import os
import sys

BACKEND = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "flybridge")
sys.path.insert(0, os.path.dirname(BACKEND))

import numpy as np  # noqa: E402
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
enc = PerceptEncoder(N_KC)

a = "user opened the settings window"
b = "user opened the settings window"
c = "a cat is on the desk next to the keyboard"

va, vb, vc = enc.encode(a), enc.encode(b), enc.encode(c)
ka, kb, kc = enc.to_kc(va), enc.to_kc(vb), enc.to_kc(vc)

ck("同一句话向量相同", np.allclose(va, vb))
ck("同一句话 KC 完全相同", np.array_equal(ka, kb))
ck("KC 数量 = K_ACTIVE", len(ka) == enc.k, len(ka))
_overlap = len(set(ka.tolist()) & set(kc.tolist())) / max(1, len(ka))
ck("不同的话 KC 明显不同", _overlap < 0.75, f"{_overlap:.2f}")
ck("KC 索引在范围内", int(ka.max()) < N_KC and int(ka.min()) >= 0)

print("[学习] 同一句话在正/负结果下应被推往不同方向")
before = enc.vecs.copy()
target = np.zeros(64, dtype=np.float32)
target[:4] = [0.8, 0.5, 0.0, 0.3]
n = enc.learn(a, target, +1.0)
after = enc.vecs.copy()
ck("learn 返回受影响的词数", n > 0, n)
ck("词向量确实变了", not np.allclose(before, after))
v2 = enc.encode(a)
ck("学习后编码发生变化", not np.allclose(va, v2))
ck("学习后仍然稳定（同句同码）", np.array_equal(enc.to_kc(v2), enc.to_kc(enc.encode(a))))

print("[持久化] 存/读后行为一致")
enc.save("encoder_test.npz")
enc2 = PerceptEncoder(N_KC)
ok = enc2.load("encoder_test.npz")
ck("读档成功", ok)
ck("读档后同一句话同码", np.array_equal(enc.to_kc(enc2.encode(a)), enc.to_kc(enc.encode(a))))
try:
    os.remove(os.path.join(os.path.dirname(BACKEND), "state", "encoder_test.npz"))
except Exception:
    pass

print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(0 if fails == 0 else 1)
