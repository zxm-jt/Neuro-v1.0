# -*- coding: utf-8 -*-
from __future__ import annotations

import hashlib
import json
import math
import re
import time
import threading
from pathlib import Path

try:
    import json as _json_ut
    from pathlib import Path as _Path_ut
except Exception:
    _json_ut = json
    _Path_ut = Path

_LOCK = threading.RLock()
_STATE = _Path_ut(__file__).resolve().parent.parent / "memory" / "capsules.json"
_DIM = 64
_CACHE: dict | None = None

_FALLBACK = {
    "enabled": True,
    "half_life_s": 86400.0,
    "learn_rate": 0.25,
    "max_capsules": 256,
    "familiar_floor": 0.55,
    "novel_boost": 1.15,
}

_TOKEN_RE = re.compile(r"[a-z0-9]+|[\u4e00-\u9fff]", re.I)


def _cfg() -> dict:
    out = dict(_FALLBACK)
    try:
        c = _json_ut.loads(
            (_Path_ut(__file__).resolve().parent.parent / "config.json").read_text(encoding="utf-8"))
        m = c.get("mind") or {}
        u = ((m.get("ecology") or {}).get("capsule_field") or m.get("capsule_field") or {})
        if isinstance(u.get("enabled"), bool):
            out["enabled"] = u["enabled"]
        for k in ("half_life_s", "learn_rate", "max_capsules", "familiar_floor", "novel_boost"):
            if isinstance(u.get(k), (int, float)):
                out[k] = float(u[k]) if k != "max_capsules" else int(u[k])
    except Exception:
        pass
    return out


def _enabled() -> bool:
    try:
        return bool(_cfg()["enabled"])
    except Exception:
        return True


def _empty() -> dict:
    return {"capsules": [], "updated_at": time.time()}


def _load() -> dict:
    global _CACHE
    with _LOCK:
        if _CACHE is not None:
            return _CACHE
        try:
            if _STATE.exists():
                d = _json_ut.loads(_STATE.read_text(encoding="utf-8"))
                if isinstance(d.get("capsules"), list):
                    _CACHE = d
                    return _CACHE
        except Exception:
            pass
        _CACHE = _empty()
        return _CACHE


def _save(d: dict):
    global _CACHE
    with _LOCK:
        _CACHE = d
        try:
            _STATE.parent.mkdir(parents=True, exist_ok=True)
            tmp = _STATE.with_suffix(".json.tmp")
            tmp.write_text(_json_ut.dumps(d, ensure_ascii=False), encoding="utf-8")
            tmp.replace(_STATE)
        except Exception:
            pass


def encode(text: str) -> list[float]:

    vec = [0.0] * _DIM
    try:
        toks = _TOKEN_RE.findall(str(text or "").lower())
        units = list(toks)
        for a, b in zip(toks, toks[1:]):
            if len(a) == 1 and len(b) == 1 and "\u4e00" <= a <= "\u9fff" and "\u4e00" <= b <= "\u9fff":
                units.append(a + b)
        for u in units:
            h = hashlib.blake2b(u.encode("utf-8"), digest_size=8).digest()
            idx = int.from_bytes(h[:4], "big") % _DIM
            sign = 1.0 if (h[4] & 1) else -1.0
            vec[idx] += sign
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]
    except Exception:
        return vec


def similarity(a: list[float], b: list[float]) -> float:

    try:
        s = sum(x * y for x, y in zip(a, b))
        return min(1.0, max(0.0, s))
    except Exception:
        return 0.0


def _strength(cap: dict, now: float, half_life: float) -> float:

    try:
        dt = max(0.0, now - float(cap.get("last_ts", now)))
        return float(cap.get("strength", 0.0)) * (0.5 ** (dt / max(1.0, half_life)))
    except Exception:
        return 0.0


def learn(text: str, *, label: str = "", confidence: float = 0.6,
          source: str = "percept") -> bool:

    if not _enabled():
        return False
    try:
        cfg = _cfg()
        vec = encode(text)
        if not any(vec):
            return False
        d = _load()
        now = time.time()
        caps = d.get("capsules") or []
        best_i, best_s = -1, 0.0
        for i, c in enumerate(caps):
            s = similarity(vec, c.get("vec") or [])
            if s > best_s:
                best_s, best_i = s, i
        if best_i >= 0 and best_s >= 0.82:
            c = caps[best_i]
            c["strength"] = min(2.0, float(c.get("strength", 0.0)) + cfg["learn_rate"])
            c["confidence"] = min(1.0, 0.7 * float(c.get("confidence", 0.5)) + 0.3 * confidence)
            c["hits"] = int(c.get("hits", 0)) + 1
            c["last_ts"] = now
        else:
            caps.append({"vec": vec, "label": str(label or text)[:80],
                         "strength": cfg["learn_rate"], "confidence": min(1.0, max(0.0, confidence)),
                         "hits": 1, "last_ts": now, "source": str(source)[:32]})
        if len(caps) > int(cfg["max_capsules"]):
            caps.sort(key=lambda c: (_strength(c, now, cfg["half_life_s"]), c.get("last_ts", 0)))
            caps = caps[-int(cfg["max_capsules"]):]
        d["capsules"] = caps
        d["updated_at"] = now
        _save(d)
        return True
    except Exception:
        return False


def familiarity(text: str) -> float:

    if not _enabled():
        return 0.5
    try:
        cfg = _cfg()
        vec = encode(text)
        d = _load()
        now = time.time()
        best = 0.0
        for c in d.get("capsules") or []:
            s = similarity(vec, c.get("vec") or [])
            if s <= 0.30:
                continue
            energy = min(1.0, _strength(c, now, cfg["half_life_s"]))
            best = max(best, s * energy * float(c.get("confidence", 0.5)))
        return min(1.0, max(0.0, best))
    except Exception:
        return 0.5


def field_factor(novelty: float, text: str) -> float:

    if not _enabled():
        return float(novelty)
    try:
        cfg = _cfg()
        fam = familiarity(text)
        mul = cfg["novel_boost"] + (cfg["familiar_floor"] - cfg["novel_boost"]) * fam
        return min(1.0, max(0.0, float(novelty) * mul))
    except Exception:
        return float(novelty)


def decay() -> int:

    if not _enabled():
        return 0
    try:
        cfg = _cfg()
        d = _load()
        now = time.time()
        before = len(d.get("capsules") or [])
        keep = [c for c in (d.get("capsules") or [])
                if _strength(c, now, cfg["half_life_s"]) >= 0.02]
        d["capsules"] = keep
        d["updated_at"] = now
        if len(keep) != before:
            _save(d)
        return before - len(keep)
    except Exception:
        return 0


def stats() -> dict:

    try:
        cfg = _cfg()
        d = _load()
        caps = d.get("capsules") or []
        now = time.time()
        strengths = [_strength(c, now, cfg["half_life_s"]) for c in caps]
        return {
            "enabled": cfg["enabled"],
            "capsules": len(caps),
            "avg_strength": round(sum(strengths) / len(strengths), 3) if strengths else 0.0,
            "top": [c.get("label", "") for c in sorted(
                caps, key=lambda x: -float(x.get("hits", 0)))[:5]],
        }
    except Exception:
        return {"enabled": False, "error": "unavailable"}


def reset() -> bool:

    _save(_empty())
    return True


if __name__ == "__main__":
    reset()
    learn("用户喜欢喝咖啡", label="coffee-pref", confidence=0.8, source="chat")
    learn("user said he likes coffee", label="coffee-pref", confidence=0.7, source="chat")
    print("familiar(喜欢咖啡)=", round(familiarity("他喜欢喝咖啡"), 3))
    print("familiar(量子物理)=", round(familiarity("量子色动力学"), 3))
    print("field_factor:", round(field_factor(0.5, "他喜欢喝咖啡"), 3),
          round(field_factor(0.5, "量子色动力学"), 3))
    print(stats())
