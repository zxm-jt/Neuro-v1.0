# -*- coding: utf-8 -*-

from __future__ import annotations

import json
from pathlib import Path

_CFG_PATH = Path(__file__).resolve().parent.parent / "config.json"

DEFAULT = {
    "introversion": 0.85,
    "shyness": 0.80,
    "warmth": 0.55,
}


def personality() -> dict:
    p = dict(DEFAULT)
    try:
        cfg = json.loads(_CFG_PATH.read_text(encoding="utf-8"))
        p.update({k: float(v) for k, v in (cfg.get("mind", {}).get("personality") or {}).items()
                  if isinstance(v, (int, float))})
    except Exception:
        pass
    for k in p:
        p[k] = max(0.0, min(1.0, float(p[k])))
    return p


def speak_offset() -> float:

    p = personality()
    return 0.08 * p["introversion"] + 0.02 * p["shyness"]


def expression_for(axes: dict) -> str:

    p = personality()
    v = float(axes.get("valence", 0.0))
    a = float(axes.get("arousal", 0.0))
    t = float(axes.get("tension", 0.0))
    shy, intro = p["shyness"], p["introversion"]

    if t > 0.45:
        if v < -0.15:
            return "worried" if a > 0.35 else "concerned"
        return "shy" if a > 0.45 else "look_down"

    if v > 0.15:
        if a > 0.55:
            loud = (1.0 - shy) * (0.5 + 0.5 * a)
            if loud > 0.55:
                return "excited" if v < 0.7 else "starry_eyes"
            return "blush" if shy > 0.6 else "happy"
        if shy > 0.65:
            return "gentle_smile" if a < 0.2 else "smile"
        return "smile"

    if v < -0.15:
        if a > 0.5:
            return "annoyed" if shy > 0.5 else "angry"
        return "sad" if intro > 0.6 else "look_down"

    if a > 0.55:
        return "curious"
    return "neutral"


def face_reply(axes: dict) -> dict:

    expr = expression_for(axes)
    return {"expression": expr, "axes": {k: round(float(v), 3) for k, v in axes.items()},
            "persona": personality()}
