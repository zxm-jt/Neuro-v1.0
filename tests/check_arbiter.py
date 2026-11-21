# -*- coding: utf-8 -*-
"""check_arbiter.py — 验证统一裁决者（不需要真脑、不需要 LLM）。
用法：python tests/check_arbiter.py"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

import arbiter  # noqa: E402
import cognition  # noqa: E402
import drive_client  # noqa: E402

fails = 0


def check(name, cond, extra=""):
    global fails
    if cond:
        print(f"  PASS {name}")
    else:
        fails += 1
        print(f"  FAIL {name}  {extra}")


class FakeDrive:
    def __init__(self, speak=0.0, fresh=True, speaking=False, label=None):
        self._speak = speak
        self._fresh = fresh
        self._speaking = speaking
        self._label = label

    def _state(self):
        return drive_client.DriveState({"actions": {"speak": self._speak},
                                        "speaking": self._speaking,
                                        "emotion": {"label": self._label},
                                        "axes": {"valence": 0.2, "arousal": 0.3,
                                                 "tension": 0.1, "satiety": 0.4}},
                                       time.time(), self._fresh)

    def latest(self):
        return self._state()

    def latest_drive_state(self):
        return self._state()

    def get_drive_client(self):
        return self

    def stimulate(self, *a, **k):
        self.stimulated = getattr(self, "stimulated", []) + [a]

    def percept(self, *a, **k):
        self.perceived = getattr(self, "perceived", []) + [a]

    def reward(self, r, **k):
        self.rewards = getattr(self, "rewards", []) + [float(r)]


def with_drive(fake):
    arbiter._dc = fake


def reset():
    arbiter._LAST["reply_silent_streak"] = 0
    arbiter._TOKENS.clear()


print("[1] 脑不可用 → 直呼必答")
with_drive(FakeDrive(fresh=False))
reset()
v = arbiter.decide("reply", text="neuro, 在吗？", addressing=True)
check("action=speak", v["action"] == "speak", v["reason"])

print("[2] 脑可用 + 驱动低 → 可以沉默；但连续不接话会被保护成开口")
with_drive(FakeDrive(speak=0.10, fresh=True))
reset()
a = arbiter.decide("reply", text="neuro?", addressing=True)
b = arbiter.decide("reply", text="neuro?", addressing=True)
check("第一次不直接答（silent/ack）", a["action"] in ("silent", "ack"), a["action"])
check("第二次被保护成开口", b["action"] == "speak", (b["action"], b["reason"]))
c = arbiter.decide("reply", text="neuro?", addressing=True)
check("开口后 streak 复位", c["action"] in ("silent", "ack"), (c["action"], c["reason"]))

print("[3] 脑可用 + 驱动高 → speak")
with_drive(FakeDrive(speak=0.9, fresh=True))
reset()
v = arbiter.decide("reply", text="随便说点什么", addressing=False)
check("action=speak", v["action"] == "speak", v["reason"])

print("[4] 主动链路驱动不足 → silent")
with_drive(FakeDrive(speak=0.12, fresh=True))   # 低于脑唤醒底线（默认 0.18）
reset()
v = arbiter.decide("vision", text="看到屏幕在动")
check("vision silent", v["action"] == "silent", v["reason"])
with_drive(FakeDrive(speak=0.95, fresh=True))
reset()
v = arbiter.decide("idle", text="")
check("idle speak（驱动够）", v["action"] == "speak", v["reason"])

print("[5] TOCTOU：裁决后用户开口 → commit 拒绝")
with_drive(FakeDrive(speak=0.9, fresh=True))
reset()
v = arbiter.decide("reply", text="讲个笑话", addressing=False)
ok1, _ = arbiter.commit(v["token"])
check("正常 commit 通过", ok1 is True)
v2 = arbiter.decide("reply", text="再讲一个", addressing=False)
cognition.user_speaking(True)
ok2, why2 = arbiter.commit(v2["token"])
check("用户开始说话后 commit 被拒", ok2 is False, why2)
cognition.user_speaking(False)

print("[6] 同一 token 不能提交两次")
v3 = arbiter.decide("reply", text="hi", addressing=False)
ok3, _ = arbiter.commit(v3["token"])
ok4, why4 = arbiter.commit(v3["token"])
check("第一次通过", ok3 is True)
check("第二次被拒", ok4 is False, why4)

print("[7] 学习信号：说话落地 / 被打断")
fd = FakeDrive(speak=0.95, fresh=True)
with_drive(fd)
reset()
v = arbiter.decide("reply", text="随便聊聊", addressing=False)
arbiter.commit(v["token"])
arbiter.on_user_spoke("嗯", addressing=False)
check("接话 → 正 reward", any(r > 0 for r in getattr(fd, "rewards", [])),
      getattr(fd, "rewards", []))
arbiter.on_interrupt()
check("打断 → 负 reward", any(r < 0 for r in getattr(fd, "rewards", [])),
      getattr(fd, "rewards", []))

print("[8] 感知进脑（注意力）")
fd2 = FakeDrive(speak=0.5, fresh=True)
with_drive(fd2)
arbiter.on_percept("user closed the settings window", 0.8)
check("percept 已送入脑", bool(getattr(fd2, "perceived", [])), getattr(fd2, "perceived", []))

print("[9] 命令通道绕过说话闸")
fd3 = FakeDrive(speak=0.05, fresh=True)
with_drive(fd3)
reset()
v = arbiter.decide("reply", text="帮我打开相机", addressing=False, command=True)
check("命令 → speak", v["action"] == "speak", v["reason"])

print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(0 if fails == 0 else 1)
