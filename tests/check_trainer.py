# -*- coding: utf-8 -*-
"""check_trainer.py — 后台自主学习（巩固）能不能真的改动权重、并落盘。"""
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import numpy as np  # noqa: E402
from flybridge.encoder import PerceptEncoder  # noqa: E402
from flybridge.assoc import AssocMemory  # noqa: E402
from flybridge.trainer import Trainer  # noqa: E402

fails = 0


def ck(name, cond, extra=""):
    global fails
    if cond:
        print(f"  PASS {name}")
    else:
        fails += 1
        print(f"  FAIL {name}  {extra}")


class StubCore:
    def __init__(self):
        self.encoder = PerceptEncoder(4064)
        self.assoc = AssocMemory(np.arange(4064), np.arange(64))
        self._axes = {"valence": 0.4, "arousal": 0.5, "tension": 0.1, "satiety": 0.3}
        self._acts = {"speak": 0.6, "look": 0.5, "withdraw": 0.2}
        now = time.time()
        self.percepts = []
        for t in ("user opened the settings window with options",
                  "user opened settings window again",
                  "a cat is on the desk"):
            self.percepts.append({"text": t, "vec": self.encoder.encode(t),
                                  "at": now - 30, "salience": 0.8})
        self._last_reward_at = now - 30


core = StubCore()
tr = Trainer(core, interval_s=0.0, idle_s=0.0)

print("[1] 巩固一轮")
W0 = core.assoc.W.copy()
V0 = core.encoder.vecs.copy()
st = tr.consolidate()
ck("ok", st.get("ok"), st)
ck("replayed > 0", st.get("replayed", 0) > 0, st.get("replayed"))
ck("encoder_pulls > 0（相似处境靠拢）", st.get("encoder_pulls", 0) > 0, st.get("encoder_pulls"))

print("[2] 权重真的变了")
ck("assoc.W 改变", not np.allclose(W0, core.assoc.W))
ck("encoder.vecs 改变", not np.allclose(V0, core.encoder.vecs))

print("[3] 记账")
log = os.path.join(ROOT, "flybridge", "state", "learn.jsonl")
ck("learn.jsonl 存在", os.path.exists(log))
if os.path.exists(log):
    line = open(log, encoding="utf-8").read().strip().splitlines()[-1]
    rec = json.loads(line)
    ck("日志里有 replayed/w_norm", "replayed" in rec and "w_norm" in rec)

print("[4] 调度：有人说话时不巩固")
core2 = StubCore()
core2.percepts[-1]["at"] = time.time()
tr2 = Trainer(core2, interval_s=0.0, idle_s=25.0)
ck("新感知期间 maybe_run 返回 None", tr2.maybe_run() is None)
core2.percepts[-1]["at"] = time.time() - 60
ck("安静后 maybe_run 会执行", tr2.maybe_run() is not None)

print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(0 if fails == 0 else 1)
