# -*- coding: utf-8 -*-
from __future__ import annotations

import re
import threading
import time
from math import exp

_LOCK = threading.RLock()
_H = {}
_HALF_LIFE_S = 90.0
_DECAY_ON_STIM = 0.72
_FLOOR = 0.15
_RECOVER_OTHER = 0.05
MAX_KEYS = 200


def _normalize(key: str) -> str:
    s = re.sub(r"\s+", " ", str(key or "")).strip().lower()
    return s[:24] or "empty"


def _now() -> float:
    return time.time()


def _recover(key: str, now: float) -> float:

    rec = _H.get(key)
    if not rec:
        return 1.0
    dt = now - rec["t"]
    v = rec["v"] + (1.0 - rec["v"]) * (1.0 - exp(-dt / _HALF_LIFE_S))
    rec["v"] = v
    rec["t"] = now
    return v


def response(key: str) -> float:

    with _LOCK:
        v = _recover(_normalize(key), _now())
        return max(_FLOOR, min(1.0, v))


def stimulate(key: str, *, strength: float = 1.0) -> float:

    k = _normalize(key)
    now = _now()
    with _LOCK:
        v = _recover(k, now)
        decay = 1.0 - (1.0 - _DECAY_ON_STIM) * max(0.0, min(1.0, strength))
        v = max(_FLOOR, v * decay)
        _H[k] = {"v": v, "t": now}
        for kk, rec in _H.items():
            if kk != k:
                rec["v"] = min(1.0, rec["v"] + _RECOVER_OTHER)
        if len(_H) > MAX_KEYS:
            oldest = sorted(_H.items(), key=lambda x: x[1]["t"])[:len(_H) - MAX_KEYS]
            for kk, _ in oldest:
                _H.pop(kk, None)
        return v


def visual_factor(text: str) -> float:

    return response("vision:" + (text or ""))


def status() -> dict:
    with _LOCK:
        now = _now()
        items = sorted(
            [{"key": k, "v": round(_recover(k, now), 3)} for k in _H],
            key=lambda x: x["v"])
        return {"keys": len(_H), "most_habituated": items[:5], "half_life_s": _HALF_LIFE_S}


def reset():
    with _LOCK:
        _H.clear()
