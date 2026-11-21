# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import math
import time
from pathlib import Path

_STATE = Path(__file__).resolve().parent.parent / "memory" / "adaptation.json"

_FALLBACK = {
    "enabled": False,
    "lr": 0.015,
    "min_samples": 8,
    "decay_s": 604800.0,
}

_BOUNDS = {
    "threshold": (-0.06, 0.06),
    "w_intrusion": (-0.08, 0.10),
    "w_social": (-0.10, 0.10),
    "w_novelty": (-0.08, 0.08),
}

_SIGNAL = {
    "responded": {"threshold": -1, "w_intrusion": -1, "w_social": +1, "w_novelty": +0.3},
    "ignored":   {"threshold": +1, "w_intrusion": +1, "w_social": -1, "w_novelty": -0.3},
    "dismissed": {"threshold": +2, "w_intrusion": +2, "w_social": -2, "w_novelty": -0.6},
}


def _cfg() -> dict:
    out = dict(_FALLBACK)
    try:
        c = json.loads((Path(__file__).resolve().parent.parent / "config.json").read_text(encoding="utf-8"))
        m = c.get("mind") or {}
        a = ((m.get("ecology") or {}).get("adaptation") or m.get("adaptation") or {})
        for k in _FALLBACK:
            if isinstance(a.get(k), bool) if k == "enabled" else isinstance(a.get(k), (int, float)):
                out[k] = a[k]
    except Exception:
        pass
    return out


def _empty() -> dict:
    return {"deltas": {k: 0.0 for k in _BOUNDS}, "samples": 0,
            "by_outcome": {}, "updated_at": time.time()}


def _load() -> dict:
    try:
        if _STATE.exists():
            d = json.loads(_STATE.read_text(encoding="utf-8"))
            ds = d.get("deltas") or {}
            d["deltas"] = {k: float(ds.get(k, 0.0)) for k in _BOUNDS}
            d.setdefault("samples", 0)
            d.setdefault("by_outcome", {})
            return d
    except Exception:
        pass
    return _empty()


def _save(d: dict):
    try:
        d["updated_at"] = time.time()
        _STATE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _STATE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(_STATE)
    except Exception:
        pass


def _decay(d: dict, cfg: dict):

    try:
        dt = max(0.0, time.time() - float(d.get("updated_at", time.time())))
        factor = 0.5 ** (dt / max(1.0, cfg["decay_s"]))
        for k in d["deltas"]:
            d["deltas"][k] *= factor
    except Exception:
        pass


def observe(outcome: str, *, context: str = "") -> bool:

    cfg = _cfg()
    sig = _SIGNAL.get(str(outcome))
    if not sig:
        return False
    try:
        d = _load()
        _decay(d, cfg)
        d["samples"] = int(d.get("samples", 0)) + 1
        bo = d.setdefault("by_outcome", {})
        bo[outcome] = int(bo.get(outcome, 0)) + 1
        if cfg["enabled"] and d["samples"] >= int(cfg["min_samples"]):
            lr = float(cfg["lr"])
            for k, direction in sig.items():
                if k not in d["deltas"]:
                    continue
                lo, hi = _BOUNDS[k]
                d["deltas"][k] = min(hi, max(lo, d["deltas"][k] + lr * float(direction)))
        _save(d)
        return bool(cfg["enabled"] and d["samples"] >= int(cfg["min_samples"]))
    except Exception:
        return False


def deltas() -> dict:

    cfg = _cfg()
    if not cfg["enabled"]:
        return {k: 0.0 for k in _BOUNDS}
    try:
        d = _load()
        if int(d.get("samples", 0)) < int(cfg["min_samples"]):
            return {k: 0.0 for k in _BOUNDS}
        return {k: round(v, 4) for k, v in d["deltas"].items()}
    except Exception:
        return {k: 0.0 for k in _BOUNDS}


def apply_to_weights(weights: dict, threshold: float) -> tuple[dict, float]:

    d = deltas()
    try:
        w = dict(weights)
        w["intrusion"] = min(1.0, max(0.0, w.get("intrusion", 0.34) + d["w_intrusion"]))
        w["social"] = min(1.0, max(0.0, w.get("social", 0.20) + d["w_social"]))
        w["novelty"] = min(1.0, max(0.0, w.get("novelty", 0.18) + d["w_novelty"]))
        thr = min(0.9, max(0.05, threshold + d["threshold"]))
        return w, thr
    except Exception:
        return dict(weights), threshold


def stats() -> dict:
    d = _load()
    return {"enabled": _cfg()["enabled"], "samples": d.get("samples", 0),
            "by_outcome": d.get("by_outcome", {}), "deltas": d.get("deltas", {})}


def reset() -> bool:
    try:
        if _STATE.exists():
            _STATE.unlink()
        return True
    except Exception:
        return False


if __name__ == "__main__":
    reset()
    for o in ["ignored"] * 10:
        observe(o)
    print("默认关闭时:", stats())
    print("增量(应为0):", deltas())
    print("ADAPTATION OK")
