# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import time
from pathlib import Path

_STATE = Path(__file__).resolve().parent.parent / "memory" / "intent.json"

_FALLBACK = {
    "enabled": True,
    "ttl_s": 1800.0,
    "decay_tau_s": 900.0,
    "min_arousal": 0.28,
    "replace_below": 0.15,
    "consistency_bonus": 0.10,
    "veto_enabled": True,
    "veto_above": 0.50,
}

_INTENT_ACTION = {
    "exploratory": {"speak": 0.7, "ack": 0.2, "wait": -0.1},
    "social":      {"speak": 0.9, "ack": 0.4, "wait": -0.2},
    "mastery":     {"speak": 0.5, "ack": 0.2, "wait": 0.0},
    "restorative": {"speak": -0.2, "ack": 0.3, "wait": 0.8},
    "restful":     {"speak": -0.4, "ack": 0.0, "wait": 1.0},
    "avoidant":    {"speak": -0.5, "ack": 0.1, "wait": 0.9},
}
_INTENT_LABEL = {
    "exploratory": "想看看新东西", "social": "想找你说说话",
    "mastery": "想把事情做好", "restorative": "想理顺/安静一下",
    "restful": "想歇一会儿", "avoidant": "想躲开一下",
}


def _cfg() -> dict:
    out = dict(_FALLBACK)
    try:
        c = json.loads((Path(__file__).resolve().parent.parent / "config.json").read_text(encoding="utf-8"))
        m = c.get("mind") or {}
        u = ((m.get("ecology") or {}).get("intent") or m.get("intent") or {})
        for k in _FALLBACK:
            if isinstance(u.get(k), bool) if k == "enabled" else isinstance(u.get(k), (int, float)):
                out[k] = u[k]
    except Exception:
        pass
    return out


def _empty() -> dict:
    return {"current": None, "history": [], "updated_at": time.time()}


def _load() -> dict:
    try:
        if _STATE.exists():
            d = json.loads(_STATE.read_text(encoding="utf-8"))
            d.setdefault("current", None)
            d.setdefault("history", [])
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


def _c01(x) -> float:
    try:
        v = float(x)
        return min(1.0, max(0.0, v)) if v == v and abs(v) != float("inf") else 0.0
    except Exception:
        return 0.0


def _brain_axes() -> dict:

    try:
        import drive_client as _dc
        d = _dc.latest_drive_state()
        if not d.fresh:
            return {"fresh": False}
        ax = d.axes or {}
        return {"fresh": True,
                "arousal": _c01(ax.get("arousal", 0.5)),
                "valence": _c01(ax.get("valence", 0.5)),
                "tension": _c01(ax.get("tension", 0.5)),
                "satiety": _c01(ax.get("satiety", 0.5)),
                "speak": _c01(d.speak), "withdraw": _c01(d.withdraw),
                "sleep_pressure": _c01(d.sleep_pressure)}
    except Exception:
        return {"fresh": False}


def _compute_candidates(brain: dict, drives: dict, n_obs: int) -> list[tuple[str, float, str]]:

    b_arousal = brain.get("arousal", 0.5)
    b_valence = brain.get("valence", 0.5)
    b_tension = brain.get("tension", 0.5)
    b_satiety = brain.get("satiety", 0.5)
    b_withdraw = brain.get("withdraw", 0.0)
    b_sleep = brain.get("sleep_pressure", 0.0)
    novelty_drive = drives.get("curiosity", 0.0)
    social_drive = drives.get("social", 0.0)
    rest_drive = drives.get("rest", 0.0)
    order_drive = drives.get("order", 0.0)
    ach_drive = drives.get("achievement", 0.0)
    boredom = drives.get("boredom", 0.0)

    arousal_gate = 1.0 if not brain.get("fresh") else (b_arousal if b_arousal >= _cfg()["min_arousal"] else 0.0)

    cands = []
    expl = (0.5 * novelty_drive + 0.3 * boredom + 0.2 * min(1.0, n_obs / 3.0))
    expl *= arousal_gate * (1.0 - 0.5 * b_satiety)
    cands.append(("exploratory", _c01(expl), "curiosity+boredom+novelty×arousal"))
    soc = social_drive * (0.5 + 0.5 * b_valence) * (1.0 - 0.4 * b_satiety) * (1.0 - 0.6 * b_withdraw)
    cands.append(("social", _c01(soc), "social-drive×valence×(1-withdraw)"))
    cands.append(("mastery", _c01(0.7 * ach_drive + 0.3 * arousal_gate), "achievement-drive"))
    cands.append(("restorative", _c01(0.6 * b_tension + 0.4 * order_drive), "brain-tension+order-drive"))
    cands.append(("restful", _c01(0.55 * b_sleep + 0.60 * rest_drive), "sleep-pressure+rest-drive"))
    cands.append(("avoidant", _c01(0.6 * b_withdraw + 0.4 * (1.0 - b_valence)), "brain-withdraw+low-valence"))
    return cands


def form(*, n_obs: int = 0, force: bool = False) -> dict:

    cfg = _cfg()
    if not cfg["enabled"] and not force:
        return current()
    try:
        import cognition as _cg
        drives = _cg.drives_snapshot()
    except Exception:
        drives = {}
    brain = _brain_axes()
    d = _load()
    now = time.time()
    cur = d.get("current")

    if cur:
        age = max(0.0, now - float(cur.get("formed_at", now)))
        decay = 0.5 ** (age / max(1.0, cfg["decay_tau_s"]))
        cur["strength"] = round(float(cur.get("strength", 0.0)) * decay, 4)
        cur["age_s"] = round(age, 1)
        expired = age > cfg["ttl_s"] or cur["strength"] < cfg["replace_below"]
        if not expired:
            d["current"] = cur
            _save(d)
            return cur

    if brain.get("fresh") and brain.get("arousal", 0.5) < cfg["min_arousal"]:
        frozen = {"type": "restful", "strength": 0.3, "why": "low-arousal-freeze",
                  "formed_at": now, "age_s": 0.0, "label": _INTENT_LABEL["restful"]}
        d["current"] = frozen
        _save(d)
        return frozen

    cands = _compute_candidates(brain, drives, n_obs)
    cands.sort(key=lambda x: -x[1])
    typ, strength, why = cands[0]
    if strength < 0.12:
        neutral = {"type": "idle", "strength": 0.2, "why": "no-dominant-drive",
                   "formed_at": now, "age_s": 0.0, "label": "没有特别想做的"}
        d["current"] = neutral
        _save(d)
        return neutral
    intent = {"type": typ, "strength": round(strength, 4), "why": why,
              "formed_at": now, "age_s": 0.0, "label": _INTENT_LABEL.get(typ, typ),
              "brain": {k: round(v, 3) for k, v in brain.items() if isinstance(v, (int, float))}}
    hist = d.get("history") or []
    hist.append({"type": typ, "strength": intent["strength"], "at": now, "why": why})
    d["history"] = hist[-30:]
    d["current"] = intent
    _save(d)
    return intent


def current() -> dict:

    cfg = _cfg()
    if not cfg["enabled"]:
        return {"type": "idle", "strength": 0.0, "label": "disabled", "why": "disabled"}
    try:
        d = _load()
        cur = d.get("current")
        if not cur:
            return {"type": "idle", "strength": 0.0, "label": "尚无意图", "why": "empty"}
        age = max(0.0, time.time() - float(cur.get("formed_at", time.time())))
        decay = 0.5 ** (age / max(1.0, cfg["decay_tau_s"]))
        out = dict(cur)
        out["strength"] = round(float(cur.get("strength", 0.0)) * decay, 4)
        out["age_s"] = round(age, 1)
        return out
    except Exception:
        return {"type": "idle", "strength": 0.0, "label": "unavailable", "why": "error"}


def consistency(action: str) -> float:

    try:
        cur = current()
        typ = cur.get("type", "idle")
        if typ not in _INTENT_ACTION:
            return 0.0
        bias = _INTENT_ACTION[typ].get(action, 0.0)
        return bias * float(cur.get("strength", 0.0))
    except Exception:
        return 0.0


def veto_proactive() -> tuple[bool, str]:

    cfg = _cfg()
    if not cfg["enabled"] or not cfg["veto_enabled"]:
        return False, ""
    try:
        cur = current()
        if cur.get("type") in ("restful", "avoidant") and float(cur.get("strength", 0.0)) >= float(cfg["veto_above"]):
            return True, f"intent_veto:{cur['type']}={cur['strength']:.2f}"
    except Exception:
        pass
    return False, ""


def satisfy(action: str, *, amount: float = 0.5) -> bool:

    try:
        d = _load()
        cur = d.get("current")
        if not cur:
            return False
        typ = cur.get("type", "")
        satisfies_map = {"exploratory": "speak", "social": "speak", "mastery": "speak",
                         "restorative": "wait", "restful": "wait", "avoidant": "wait"}
        if satisfies_map.get(typ) == action:
            cur["strength"] = round(float(cur.get("strength", 0.0)) * (1.0 - _c01(amount)), 4)
            d["current"] = cur
            _save(d)
            return True
        return False
    except Exception:
        return False


def stats() -> dict:
    d = _load()
    c = current()
    return {"enabled": _cfg()["enabled"], "current": c,
            "history_len": len(d.get("history") or []),
            "recent": (d.get("history") or [])[-3:]}


def reset() -> bool:
    try:
        if _STATE.exists():
            _STATE.unlink()
        return True
    except Exception:
        return False


if __name__ == "__main__":
    reset()
    it = form(n_obs=2)
    print("驱力驱动意图:", it["type"], it["strength"], it["why"])
    print("一致性偏置(speak):", round(consistency("speak"), 3))
    satisfy("speak", amount=0.6)
    print("满足后:", round(current()["strength"], 3))
    print(stats())
    print("INTENT OK")
