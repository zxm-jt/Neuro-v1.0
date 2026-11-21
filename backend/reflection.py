# -*- coding: utf-8 -*-
from __future__ import annotations

import datetime
import json
import os
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MEM_DIR = ROOT / "memory"
LOG = MEM_DIR / "reflection.jsonl"
INSIGHTS = MEM_DIR / "reflection_insights.json"

_LOCK = threading.RLock()
_MIN_OUTCOMES_FOR_REFLECT = 12
_IGNORE_WINDOW_S = 60.0
_RESPOND_WINDOW_S = 60.0

_pending: list[dict] = []

_TICK_THREAD_STARTED = False
_outcome_hook = None


def set_outcome_hook(fn):
    global _outcome_hook
    _outcome_hook = fn


def _start_tick_thread():
    global _TICK_THREAD_STARTED
    if _TICK_THREAD_STARTED:
        return
    _TICK_THREAD_STARTED = True

    def _loop():
        import time
        while True:
            time.sleep(10.0)
            try:
                tick()
            except Exception:
                pass

    try:
        t = threading.Thread(target=_loop, name="reflection-tick", daemon=True)
        t.start()
    except Exception:
        _TICK_THREAD_STARTED = False


def _ensure_dir():
    try:
        MEM_DIR.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass


def log_decision(kind: str, chosen: str, scores: dict | None = None,
                 drives: dict | None = None, reason: str = "",
                 token: str = "", text: str = "") -> bool:

    try:
        import uuid
        rec = {
            "id": uuid.uuid4().hex[:12],
            "t": round(datetime.datetime.now().timestamp(), 3),
            "kind": str(kind), "chosen": str(chosen),
            "scores": {k: round(float(v), 4) for k, v in (scores or {}).items()},
            "drives": {k: round(float(v), 3) for k, v in (drives or {}).items()},
            "reason": str(reason)[:200],
            "outcome": None,
        }
        _ensure_dir()
        with _LOCK:
            with open(LOG, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if chosen == "speak" and token:
                _pending.append({"id": rec["id"], "t": rec["t"], "token": token,
                                 "kind": kind, "text": str(text)[:120]})
                if len(_pending) > 50:
                    del _pending[:-50]
                _start_tick_thread()
        return True
    except Exception:
        return False


def on_user_reaction(*, kind: str = "responded", text: str = ""):

    try:
        with _LOCK:
            if not _pending:
                return False
            item = _pending[-1]
            item["outcome"] = kind
            _append_outcome(item.get("id", ""), kind, text)
            _pending.clear()
        if _outcome_hook is not None:
            try:
                _outcome_hook(kind, text)
            except Exception:
                pass
        return True
    except Exception:
        return False


def tick():

    _start_tick_thread()
    import time
    now = time.time()
    fired = []
    with _LOCK:
        keep = []
        for item in _pending:
            if now - item["t"] > _IGNORE_WINDOW_S:
                _append_outcome(item.get("id", ""), "ignored", "")
                fired.append(item)
            else:
                keep.append(item)
        _pending[:] = keep
    if fired and _outcome_hook is not None:
        try:
            _outcome_hook("ignored", "")
        except Exception:
            pass


def _append_outcome(decision_id: str, outcome: str, text: str = ""):

    try:
        if not LOG.exists():
            return
        lines = LOG.read_text(encoding="utf-8").splitlines()
        changed = False
        out = []
        for ln in lines:
            try:
                rec = json.loads(ln)
            except Exception:
                out.append(ln)
                continue
            if (not rec.get("outcome")) and rec.get("id") == decision_id:
                rec["outcome"] = outcome
                if text:
                    rec["reaction"] = str(text)[:120]
                changed = True
                out.append(json.dumps(rec, ensure_ascii=False))
            else:
                out.append(ln)
        if changed:
            LOG.write_text("\n".join(out) + "\n", encoding="utf-8")
    except Exception:
        pass


def _load_records() -> list[dict]:
    try:
        if not LOG.exists():
            return []
        out = []
        for ln in LOG.read_text(encoding="utf-8").splitlines():
            try:
                out.append(json.loads(ln))
            except Exception:
                pass
        return out
    except Exception:
        return []


def stats() -> dict:

    recs = _load_records()
    spoken = [r for r in recs if r.get("chosen") == "speak"]
    with_out = [r for r in recs if r.get("outcome")]
    n = len(with_out) or 1
    responded = sum(1 for r in with_out if r.get("outcome") == "responded")
    ignored = sum(1 for r in with_out if r.get("outcome") == "ignored")
    dismissed = sum(1 for r in with_out if r.get("outcome") == "dismissed")
    import time
    cutoff = time.time() - 3600
    last_hour = sum(1 for r in spoken if float(r.get("t", 0)) >= cutoff)
    return {
        "total_decisions": len(recs),
        "proactive_spoken": len(spoken),
        "proactive_last_hour": last_hour,
        "intrusion_rate": round((ignored + dismissed) / n, 3),
        "relevance_rate": round(responded / n, 3),
        "outcomes": {"responded": responded, "ignored": ignored, "dismissed": dismissed},
    }


def reflect() -> dict:

    recs = _load_records()
    with_out = [r for r in recs if r.get("outcome")]
    if len(with_out) < _MIN_OUTCOMES_FOR_REFLECT:
        return {"ok": False, "reason": "not_enough_outcomes",
                "have": len(with_out), "need": _MIN_OUTCOMES_FOR_REFLECT}

    s = stats()
    suggestions = []
    if s["intrusion_rate"] > 0.4:
        suggestions.append({"target": "mind.utility.threshold",
                            "suggest": 0.32,
                            "why": f"打扰率 {s['intrusion_rate']:.0%} 偏高，抬高主动门槛"})
        suggestions.append({"target": "mind.utility.hourly_proactive_cap",
                            "suggest": 6, "why": "打扰率高，收紧每小时预算"})
    elif s["relevance_rate"] > 0.7 and s["proactive_last_hour"] < 2:
        suggestions.append({"target": "mind.utility.threshold",
                            "suggest": 0.24,
                            "why": f"回应率 {s['relevance_rate']:.0%} 高但主动少，可略放宽"})
    by_hour: dict[int, list[int]] = {}
    for r in with_out:
        try:
            hh = datetime.datetime.fromtimestamp(float(r["t"])).hour
            by_hour.setdefault(hh, []).append(1 if r["outcome"] == "responded" else 0)
        except Exception:
            pass
    good_hours = [hh for hh, vals in by_hour.items()
                  if len(vals) >= 3 and sum(vals) / len(vals) >= 0.7]
    if good_hours:
        suggestions.append({"target": "mind.utility.quiet_hours_note",
                            "suggest": sorted(good_hours),
                            "why": "这些时段回应率高，可考虑作为优先主动窗口"})

    insight = {
        "at": _now_str(), "stats": s,
        "suggestions": suggestions,
        "note": "建议仅供参考，不自动生效；改 config 后重启应用。",
    }
    try:
        _ensure_dir()
        INSIGHTS.write_text(json.dumps(insight, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass
    return {"ok": True, "insight": insight}


def _now_str():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def diag_line() -> str:
    s = stats()
    return (f"[reflection] spoken={s['proactive_spoken']}/h={s['proactive_last_hour']} "
            f"intrusion={s['intrusion_rate']:.2f} relevance={s['relevance_rate']:.2f}")
