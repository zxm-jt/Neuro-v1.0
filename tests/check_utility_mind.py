import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import cognition as c
import arbiter as a
import drive_client as _dc

class _StaleDrive:
    fresh = False
    speaking = False
    withdraw = 0.0
    recall_strength = 0.0
    speak = 0.0
    def summary(self): return {"available": False}
_dc.latest_drive_state = lambda: _StaleDrive()
a._dc.latest_drive_state = lambda: _StaleDrive()

PASS = []
FAIL = []


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


print("=" * 60)
print("效用选择 + 6 驱力 自检")
print("=" * 60)

reset()
d = c.drives_snapshot()
check("6 驱力齐全", set(d.keys()) == set(c.DRIVE_NAMES), str(list(d.keys())))
check("驱力值在 0~1", all(0.0 <= v <= 1.0 for v in d.values()), str(d))

reset()
c.drive_event("praise")
check("夸奖→成就感↑", c.drives_snapshot()["achievement"] > c._DV_FALLBACK["base"]["achievement"])
reset()
c.drive_set("social", 0.9)
c.drive_event("social_contact")
check("社交接触→社交需求↓", c.drives_snapshot()["social"] < 0.9)
reset()
c.drive_set("order", 0.9)
c.drive_event("task_done")
check("任务完成→秩序需求↓", c.drives_snapshot()["order"] < 0.9)
reset()
c.drive_event("novelty")
snap = c.drives_snapshot()
check("新异→好奇↑且无聊↓", snap["curiosity"] > c._DV_FALLBACK["base"]["curiosity"]
      and snap["boredom"] < c._DV_FALLBACK["base"]["boredom"])

reset()
c.drive_set("curiosity", 1.0)
c._WM["drives_t"] = time.time() - 86400.0
drifted = c.drives_snapshot()["curiosity"]
check("时间漂移回归基线", abs(drifted - c._DV_FALLBACK["base"]["curiosity"]) < 0.05,
      f"curiosity={drifted:.3f}")

reset()
base = a.utility_scores("reply", addressing=False)["U"]["speak"]
hi_social = a.utility_scores("reply", addressing=True)["U"]["speak"]
check("社交价值↑→效用↑", hi_social > base, f"{base:.3f}→{hi_social:.3f}")
reset()
c._WM["last_proactive_ts"] = time.time() - 4000
idle_base = a.utility_scores("idle")["U"]["speak"]
c.tts_state(True, 0)
hi_intrusion = a.utility_scores("idle")["U"]["speak"]
c.tts_state(False, 0)
check("打扰↑→主动效用↓", hi_intrusion < idle_base, f"{idle_base:.3f}→{hi_intrusion:.3f}")
reset()
c._WM["last_proactive_ts"] = time.time() - 10
low_delay = a.utility_scores("idle")["U"]["speak"]
c._WM["last_proactive_ts"] = time.time() - 4000
high_delay = a.utility_scores("idle")["U"]["speak"]
check("延迟↑→主动效用↑", high_delay > low_delay, f"{low_delay:.3f}→{high_delay:.3f}")

reset()
c._WM["last_proactive_ts"] = time.time() - 20
v1 = a.decide("idle")
check("刚主动说完→沉默", v1["action"] == "silent", v1["reason"])
reset()
c._WM["last_proactive_ts"] = time.time() - 4000
v2 = a.decide("idle")
check("隔久了→可主动开口", v2["action"] in ("speak", "ack"), v2["reason"])

# 【2026-11-21】旧断言写死 [[0,23]]：只在 00:00-22:59 成立，23 点整跑测试必红。
# 改成围绕"当前小时"构造窗口（跨零点也覆盖到），与具体钟点无关。
_hh = __import__("time").localtime().tm_hour
check("静默时段识别",
      a._in_quiet_hours(time.time(), [[(_hh + 23) % 24, (_hh + 1) % 24]]) is True
      and a._in_quiet_hours(time.time(), []) is False)

# 7. 异常回落：utility 关闭仍可 decide
reset()
orig = a._util_cfg
a._util_cfg = lambda: dict(orig(), enabled=False)
try:
    v3 = a.decide("reply", text="你好", addressing=True)
    check("utility关闭→回落脑开关", v3["action"] in ("speak", "ack", "silent"), v3["reason"])
finally:
    a._util_cfg = orig

print("-" * 60)
print(f"结果: {len(PASS)} PASS / {len(FAIL)} FAIL")
if FAIL:
    print("失败项:", FAIL)
    sys.exit(1)
print("ALL PASS")
