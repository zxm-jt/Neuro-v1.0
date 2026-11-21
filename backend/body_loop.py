# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_LOCK = threading.RLock()

_ACTION_MAP = {
    "look":        ("novelty",      "vision",  0.45, "我转头看向了新东西"),
    "speak":       ("social_contact", "touch", 0.35, "我刚对她说了话"),
    "expression":  ("praise",       "touch",   0.20, "我露出了一个表情"),
    "motion":      ("novelty",      "touch",   0.15, "我动了一下"),
    "headpat":     ("social_contact", "touch", 0.60, "我被摸了头，开心"),
    "rest":        ("rest",         "none",    0.0,  "我在安静地休息"),
    "withdraw":    ("interrupt",    "none",    0.0,  "我缩回去了"),
}

_stats = {"acts": 0, "by_action": {}, "last_ts": 0.0}


def _enabled() -> bool:
    try:
        cfg = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
        bl = ((cfg.get("mind") or {}).get("body_loop") or {})
        return bool(bl.get("enabled", True))
    except Exception:
        return True


def act(action: str, *, intensity: float = 1.0, detail: str = "") -> dict:

    action = (action or "").strip().lower()
    if action not in _ACTION_MAP:
        return {"ok": False, "reason": "unknown_action", "action": action}
    if not _enabled():
        return {"ok": False, "reason": "disabled", "action": action}

    drive_evt, brain_kind, amp, self_text = _ACTION_MAP[action]
    amp = max(0.0, min(1.0, float(amp) * max(0.0, min(1.0, intensity))))
    results = {"action": action, "self_text": self_text, "ok": True}

    try:
        import cognition as cg
        cg.drive_event(drive_evt, intensity)
        results["drive_event"] = drive_evt
    except Exception as e:
        results["drive_error"] = type(e).__name__

    try:
        import drive_client as dc
        if brain_kind == "vision":
            dc.get_drive_client().stimulate("vision", amp)
        elif brain_kind == "touch":
            dc.get_drive_client().stimulate("touch", amp)
        results["brain_stim"] = brain_kind
    except Exception as e:
        results["brain_error"] = type(e).__name__

    try:
        import cognition as cg
        cg.observe(f"[self] {self_text}" + (f" ({detail})" if detail else ""))
    except Exception:
        pass

    with _LOCK:
        _stats["acts"] += 1
        _stats["by_action"][action] = _stats["by_action"].get(action, 0) + 1
        _stats["last_ts"] = time.time()
    return results


def reflex(boredom: float | None = None, rest: float | None = None) -> str | None:

    try:
        import cognition as cg
        d = cg.drives_snapshot()
        b = d.get("boredom", 0) if boredom is None else boredom
        r = d.get("rest", 0) if rest is None else rest
        if r > 0.75:
            return "rest"
        if b > 0.6:
            return "look"
    except Exception:
        pass
    return None


def close_loop() -> dict | None:

    try:
        import cognition as cg
        before = cg.drives_snapshot()
        a = reflex()
        if not a:
            return None
        act(a)
        after = cg.drives_snapshot()
        return {"action": a, "before": before, "after": after}
    except Exception:
        return None


def status() -> dict:
    with _LOCK:
        return dict(_stats)
