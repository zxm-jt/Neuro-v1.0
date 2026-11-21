from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

from .paths import STATE

WAKE_KICK = 0.02
SLEEP_TAU_H = 6.0


def _p(path: str) -> Path:
    q = Path(path)
    return q if q.is_absolute() else STATE / q


def save(brain, scalars: dict, path: str = "life.npz") -> str:
    STATE.mkdir(parents=True, exist_ok=True)
    p = _p(path)
    payload = {
        "v": np.asarray(brain.v, dtype=np.float32),
        "fired": np.asarray(brain.fired, dtype=np.int64),
        "steps": np.int64(brain.steps),
        "rng": np.frombuffer(json.dumps(brain.rng.bit_generator.state).encode("utf-8"), dtype=np.uint8),
        "scalars": np.frombuffer(json.dumps(scalars, ensure_ascii=False).encode("utf-8"), dtype=np.uint8),
        "saved_at": np.float64(time.time()),
    }
    if getattr(brain, "last_spike", None) is not None:
        payload["last_spike"] = np.asarray(brain.last_spike, dtype=np.int32)
    tmp = p.with_suffix(".tmp.npz")
    np.savez_compressed(tmp, **payload)
    tmp.replace(p)
    return str(p)


def load(brain, path: str = "life.npz", kick: bool = True) -> dict | None:

    p = _p(path)
    if not p.exists():
        return None
    try:
        z = np.load(p, allow_pickle=False)
    except Exception as e:
        print(f"[persist] 存档损坏: {e}")
        return None
    try:
        v = np.asarray(z["v"], dtype=np.float32)
        if v.shape == tuple(np.asarray(brain.v).shape):
            brain.v = v
        brain.fired = np.asarray(z["fired"], dtype=np.int64)
        if "last_spike" in z and getattr(brain, "last_spike", None) is not None:
            brain.last_spike = np.asarray(z["last_spike"], dtype=np.int32)
        brain.steps = int(z["steps"])
        brain.rng.bit_generator.state = json.loads(bytes(z["rng"]).decode("utf-8"))
        scalars = json.loads(bytes(z["scalars"]).decode("utf-8")) if "scalars" in z else {}
        saved_at = float(z["saved_at"]) if "saved_at" in z else time.time()
    except Exception as e:
        print(f"[persist] 读档失败: {e}")
        return None

    offline_s = max(0.0, time.time() - saved_at)
    if kick and offline_s > 60:
        rng = np.random.default_rng(brain.steps)
        brain.v += rng.normal(0.0, WAKE_KICK, size=brain.v.shape).astype(np.float32)
    return {"scalars": scalars, "offline_s": offline_s}


def advance_offline(scalars: dict, offline_s: float) -> dict:

    s = dict(scalars or {})
    hours = offline_s / 3600.0
    sp = float(s.get("sleep_pressure", 0.0))
    sp = 1.0 - (1.0 - sp) * np.exp(-hours / SLEEP_TAU_H)
    s["sleep_pressure"] = float(min(1.0, max(0.0, sp)))
    s["hours_offline"] = round(hours, 3)
    if offline_s > 60:
        s["company_satiety"] = float(max(0.0, float(s.get("company_satiety", 0.5)) - min(0.5, hours * 0.05)))
    return s
