# -*- coding: utf-8 -*-
"""check_persona.py — 人格不是规则，是连续的偏好。
用法：python tests/check_persona.py"""
import json
import os
import sys

BACKEND = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend")
sys.path.insert(0, BACKEND)

import persona  # noqa: E402

fails = 0


def ck(name, cond, extra=""):
    global fails
    if cond:
        print(f"  PASS {name}")
    else:
        fails += 1
        print(f"  FAIL {name}  {extra}")


def with_traits(**kw):
    persona.personality = lambda: dict(persona.DEFAULT, **kw)


print("[1] 同一份情绪，不同人格 → 不同的脸")
axes_happy_high = {"valence": 0.8, "arousal": 0.8, "tension": 0.0, "satiety": 0.3}
with_traits(shyness=0.9)
shy_face = persona.expression_for(axes_happy_high)
with_traits(shyness=0.05)
open_face = persona.expression_for(axes_happy_high)
print(f"  腼腆={shy_face}  外向={open_face}")
ck("腼腆的人不会用 excited/starry_eyes", shy_face not in ("excited", "starry_eyes"), shy_face)
ck("外向的人会用张扬的脸", open_face in ("excited", "starry_eyes"), open_face)
ck("两者不同", shy_face != open_face)

print("[2] 紧张优先")
with_traits(shyness=0.8)
ck("紧张+负效价 → 担心/忧虑",
   persona.expression_for({"valence": -0.3, "arousal": 0.3, "tension": 0.7}) in ("worried", "concerned"))
ck("紧张+高唤醒+正效价 → 羞", persona.expression_for({"valence": 0.3, "arousal": 0.6, "tension": 0.6}) in ("shy", "look_down"))

print("[3] 中性")
ck("全零 → neutral", persona.expression_for({}) == "neutral")

print("[4] 人格抬高开口门槛")
with_traits(introversion=0.0, shyness=0.0)
low = persona.speak_offset()
with_traits(introversion=1.0, shyness=1.0)
high = persona.speak_offset()
print(f"  外向 offset={low:.3f}  内向 offset={high:.3f}")
ck("内向门槛更高", high > low)
ck("偏移在合理范围（不封死开口）", 0.0 <= low <= high <= 0.12)

print("[5] 真实 config 可覆盖人格")
cfg = json.loads(open(os.path.join(os.path.dirname(BACKEND), "config.json"),
                      encoding="utf-8").read())
p = persona.personality()
import importlib
importlib.reload(persona)
p = persona.personality()
ck("读到了 config 的 personality 或默认值", set(p) >= {"introversion", "shyness", "warmth"})

print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(0 if fails == 0 else 1)
