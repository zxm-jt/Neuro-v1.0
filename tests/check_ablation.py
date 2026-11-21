import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import arbiter as a
import cognition as c
import habituation as hab

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("  PASS " if cond else "  FAIL ") + name + (f"  [{detail}]" if detail else ""))


def reset():
    for n in c.DRIVE_NAMES:
        c.drive_set(n, c._DV_FALLBACK["base"][n])
    c._WM["last_proactive_ts"] = 0.0
    c._WM["proactive_count_hour"] = 0
    c._WM["proactive_hour_bucket"] = time.localtime().tm_hour
    c._WM["task_active"] = False
    c._WM["tts_playing"] = False
    c._WM["asr_busy"] = False
    c._WM["instruction_guard_until"] = 0.0
    c._WM["pending_observations"] = []
    hab.reset()


_orig_abl = a._abl
def set_abl(**components):
    a._abl = lambda name: bool(components.get(name, False))


print("=" * 62)
print("消融对比 — 四组件贡献验证")
print("=" * 62)

reset()
set_abl()
full = a.utility_decide("idle")
set_abl(utility=True)
abl = a.decide("idle")
check("utility 消融后仍有决策（回落脑开关）", abl["action"] in ("speak", "ack", "silent"), abl["reason"])
check("utility 启用时 reason 带 utility 标记", "utility" in full[2], full[2])

set_abl()
reset(); c.drive_set("social", 1.0); c.drive_set("curiosity", 1.0)
with_drives = a.utility_scores("idle")["U"]["speak"]
set_abl(drives=True)
no_drives = a.utility_scores("idle")["U"]["speak"]
check("drives 消融 → 驱力贡献消失", abs(with_drives - no_drives) > 0.01,
      f"有驱力={with_drives:.3f} 无驱力={no_drives:.3f}")

set_abl()
reset()
c._WM["pending_observations"] = [{"at": time.time(), "text": "打开了一个代码编辑器窗口"}]
for _ in range(6):
    hab.stimulate("vision:打开了一个代码编辑器窗口", strength=1.0)
habituated = a.utility_scores("idle")["terms"]["novelty"]
set_abl(habituation=True)
no_habit = a.utility_scores("idle")["terms"]["novelty"]
check("习惯化生效：重复刺激 novelty 下降", habituated < no_habit,
      f"习惯化后={habituated:.3f} 未习惯化={no_habit:.3f}")

class FakeLow:
    fresh=True; speaking=False; withdraw=0.0; speak=0.12   # 低于脑唤醒底线 0.18
    recall_strength=0.0; summary=lambda self: {}
class FakeHigh(FakeLow):
    speak=0.9
_orig_lds = a._dc.latest_drive_state
try:
    set_abl()
    c._WM["last_proactive_ts"] = time.time() - 4000
    a._dc.latest_drive_state = lambda: FakeLow()
    low_blocked = a.utility_decide("idle")[0]
    set_abl(**{"brain-gate": True})
    low_unblocked = a.utility_decide("idle")[0]
    check("脑门控消融 → 低唤醒不再被拦", low_blocked == "silent" and low_unblocked == "speak",
          f"有门控={low_blocked} 无门控={low_unblocked}")
    a._dc.latest_drive_state = lambda: FakeHigh()
    set_abl()
    high = a.utility_decide("idle")[0]
    check("高唤醒能过脑门控", high == "speak", high)
finally:
    a._dc.latest_drive_state = _orig_lds

a._abl = _orig_abl
reset()

print("-" * 62)
print(f"结果: {len(PASS)} PASS / {len(FAIL)} FAIL")
if FAIL:
    print("失败项:", FAIL)
    sys.exit(1)
print("ALL PASS")
