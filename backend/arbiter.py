# -*- coding: utf-8 -*-

from __future__ import annotations

import math
import threading
import time
import uuid

import cognition as _cg
import drive_client as _dc
import persona as _persona

LOCK = threading.RLock()

TH = {
    "reply":  (0.36, 0.22),
    "vision": (0.68, 0.50),
    "idle":   (0.72, 0.55),
}
PROACTIVE_TH = 0.55
TOKEN_TTL_S = 12.0
COLD_STREAK_LIMIT = 1

_LAST = {
    "reply_silent_streak": 0,
    "last_kind": "",
    "last_decision_ts": 0.0,
    "last_reason": "",
    "spoke_at": 0.0,
}
_TOKENS: dict[str, dict] = {}

_HOOK_REGISTERED = False


_ADDRESS_RE = None


def is_command(text: str) -> bool:

    t = (text or "").strip()
    if len(t) < 3:
        return False
    try:
        if _cg._NOT_INSTRUCTION_RE.search(t):
            return False
        if _cg._MENTION_NOT_COMMAND.search(t):
            return False
        return bool(_cg._VERB_AT_START.search(t) or _cg._IMPERATIVE_PREFIX.search(t))
    except Exception:
        return False


_PRAISE_RE = None
_INSULT_RE = None


def on_user_text(text: str):

    global _PRAISE_RE, _INSULT_RE
    t = (text or "")
    if not t:
        return
    if _PRAISE_RE is None:
        import re
        _PRAISE_RE = re.compile(
            r"(可爱|cute|好看|漂亮|喜欢你|爱你|love you|adorable|lovely|"
            r"太棒|真好|好厉害|amazing|so sweet|best)", re.I)
        _INSULT_RE = re.compile(r"(讨厌|笨蛋|stupid|idiot|闭嘴|shut up|hate you|烦死)", re.I)
    try:
        drv = _dc.get_drive_client()
        if _PRAISE_RE.search(t):
            drv.stimulate("praise", 0.75)
        elif _INSULT_RE.search(t):
            drv.stimulate("interrupt", 0.5)
    except Exception:
        pass


def addressing(text: str) -> bool:

    global _ADDRESS_RE
    t = (text or "").strip().lower()
    if not t:
        return False
    if "neuro" in t or "尼奥" in t:
        return True
    if t.endswith(("?", "？")):
        return True
    if _ADDRESS_RE is None:
        import re
        _ADDRESS_RE = re.compile(
            r"(?:\bhi\b|\bhey\b|\bhello\b|\bhiya\b|你好|您好|在吗|在不在|嗨|喂)", re.I)
    return bool(_ADDRESS_RE.search(t))


def _decide_reply(*, addressing: bool, text: str, urgency: float) -> tuple[str, float, str]:

    drv = _dc.latest_drive_state()
    if drv.fresh:
        speak_at, ack_under = TH["reply"]
        speak_at += _persona.speak_offset()
        eff = drv.speak + (0.30 if addressing else 0.0) + max(0.0, min(0.3, urgency))
        if _LAST["reply_silent_streak"] >= COLD_STREAK_LIMIT and addressing:
            return "speak", eff, f"连续沉默保护→开口（streak={_LAST['reply_silent_streak']}）"
        if eff >= speak_at:
            return "speak", eff, f"brain_speak={eff:.2f}>={speak_at}"
        if eff >= ack_under:
            return "ack", eff, f"ack（{eff:.2f} 低于 {speak_at}）"
        return "silent", eff, f"brain_speak={eff:.2f}<{ack_under}"
    return "speak", 0.0, "brain_unavailable: 回落到旧行为"


_UNHEARD: list = []
UNHEARD_MAX = 6


def remember_unheard(text: str):

    t = (text or "").strip()
    if not t:
        return
    with LOCK:
        _UNHEARD.append(t[:200])
        while len(_UNHEARD) > UNHEARD_MAX:
            _UNHEARD.pop(0)


def heard_block() -> str:

    with LOCK:
        items = list(_UNHEARD)
    if not items:
        return ""
    lines = "\n".join(f"- {t}" for t in items)
    return ("[Heard, not answered] you heard these but stayed quiet:\n" + lines +
            "\n(The newest message is the one to respond to now.)")


def clear_unheard():
    with LOCK:
        _UNHEARD.clear()


def peek(kind: str, *, text: str = "", addressing: bool = False,
         command: bool = False) -> dict:

    kind = (kind or "").lower()
    if kind == "reply" and command:
        return _verdict("speak", "command", _dc.latest_drive_state().speak)
    drv = _dc.latest_drive_state()
    if kind == "reply":
        action, drive, reason = _decide_reply(addressing=addressing, text=text, urgency=0.0)
    elif drv.fresh:
        speak_at, _ = TH.get(kind, TH["idle"])
        drive = drv.speak
        action = "speak" if drive >= speak_at else "silent"
        reason = f"brain_speak={drive:.2f}"
    else:
        action, drive, reason = "speak", 0.0, "brain_unavailable"
    return _verdict(action, reason, drive)


def note_spoke():

    with LOCK:
        _LAST["spoke_at"] = time.time()


def decide(kind: str, *, text: str = "", addressing: bool = False,
           urgency: float = 0.0, source: str = "", command: bool = False) -> dict:

    kind = (kind or "").lower()
    if kind not in ("reply", "vision", "idle"):
        raise ValueError(f"unknown kind: {kind}")

    now = time.time()
    udetail = {}
    if kind in ("vision", "idle"):
        try:
            ok, why = _cg.can_speak_proactive(source=kind)
        except Exception as e:
            ok, why = False, f"cognition_error:{e}"
        if not ok:
            return _verdict("silent", why, 0.0)

    if kind == "reply" and command:
        drv = _dc.latest_drive_state()
        _record("reply", "speak", "command", now)
        tok = uuid.uuid4().hex
        with LOCK:
            _TOKENS[tok] = {"kind": kind, "action": "speak", "at": now,
                            "expires": now + TOKEN_TTL_S, "reason": "command"}
        return _verdict("speak", "command", drv.speak, tok)

    drv = _dc.latest_drive_state()
    if kind == "reply":
        action, drive, reason = _decide_reply(addressing=addressing, text=text, urgency=urgency)
    else:
        uact, uscore, ureason, udetail = utility_decide(
            kind, addressing=addressing, text=text, urgency=urgency)
        action, drive, reason = uact, uscore, ureason
        if action in ("speak", "ack") and drv.fresh:
            if drv.speaking:
                return _verdict("silent", ureason + "+brain:speaking", drive)
            if drv.withdraw > 0.72:
                return _verdict("silent", ureason + f"+brain:withdraw={drv.withdraw:.2f}", drive)
        if action == "speak" and not _abl("intent"):
            try:
                import intent as _it
                _veto, _vwhy = _it.veto_proactive()
                if _veto:
                    udetail["intent_veto"] = _vwhy
                    return _verdict("silent", reason + "+" + _vwhy, drive)
            except Exception:
                pass

    tok = None
    if action in ("speak", "ack"):
        tok = uuid.uuid4().hex
        with LOCK:
            _TOKENS[tok] = {"kind": kind, "action": action, "at": now,
                            "expires": now + TOKEN_TTL_S, "reason": reason}
    _record(kind, action, reason, now)
    if kind in ("vision", "idle"):
        try:
            import reflection as _rf
            _rf.log_decision(kind, action, scores={"chosen_utility": drive},
                             drives=(udetail.get("drives", {}) or {}),
                             reason=reason, token=tok or "", text=text)
        except Exception:
            pass
        if action == "speak":
            try:
                import body_loop as _bl
                _bl.act("speak", intensity=0.5, detail=text[:40])
            except Exception:
                pass
            try:
                import intent as _it
                _it.satisfy("speak", amount=0.4)
            except Exception:
                pass
    return _verdict(action, reason, drive, tok)


def _verdict(action: str, reason: str, drive: float, token: str | None = None) -> dict:
    return {"action": action, "reason": reason, "token": token,
            "drive": round(float(drive), 3)}


def commit(token: str) -> tuple[bool, str]:

    if not token:
        return True, "no_token"
    now = time.time()
    with LOCK:
        info = _TOKENS.pop(token, None)
    if not info:
        return False, "token_unknown_or_used"
    if now > info["expires"]:
        return False, f"token_expired({now - info['at']:.1f}s)"
    try:
        snap = _cg.snapshot()
    except Exception:
        snap = {}
    if snap.get("asr_busy"):
        return False, "user_started_speaking"
    if snap.get("tts_playing") and info["kind"] != "reply":
        return False, "tts_started"
    drv = _dc.latest_drive_state()
    if info["kind"] != "reply" and drv.fresh and drv.speaking:
        return False, "brain:now_speaking"
    if info["kind"] in ("vision", "idle"):
        ok, why = _cg.can_speak_proactive(source=info["kind"])
        if not ok:
            return False, f"gate_now:{why}"
    try:
        _cg.neuro_spoke("", proactive=(info["kind"] in ("vision", "idle")))
        with LOCK:
            _LAST["spoke_at"] = now
    except Exception:
        pass
    return True, "ok"


def abort(token: str):
    if not token:
        return
    with LOCK:
        _TOKENS.pop(token, None)


def _record(kind: str, action: str, reason: str, now: float):
    with LOCK:
        _LAST["last_kind"] = kind
        _LAST["last_decision_ts"] = now
        _LAST["last_reason"] = reason
        if kind == "reply":
            if action == "speak":
                _LAST["reply_silent_streak"] = 0
            else:
                _LAST["reply_silent_streak"] += 1


def on_user_spoke(text: str = "", *, addressing: bool = False, amp: float = 0.55):

    try:
        drv = _dc.get_drive_client()
        drv.stimulate("touch", amp + (0.15 if addressing else 0.0))
        with LOCK:
            _spoke = float(_LAST.get("spoke_at") or 0.0)
        gap = time.time() - _spoke if _spoke > 0 else -1
        _expr = _current_expression()
        if 0 <= gap <= 45:
            drv.reward(0.25, why="user_replied_within_45s", expr=_expr)
        elif 45 < gap <= 180 and addressing:
            drv.reward(0.10, why="user_sought_her", expr=_expr)
    except Exception:
        pass
    try:
        _cg.drive_event("social_contact", 1.0 if addressing else 0.5)
    except Exception:
        pass
    try:
        import reflection as _rf
        _register_reflection_hook()
        _rf.tick()
        _rf.on_user_reaction(kind="responded", text=text)
    except Exception:
        pass


def on_interrupt():
    try:
        drv = _dc.get_drive_client()
        drv.stimulate("interrupt", 0.8)
        drv.reward(-0.5, why="interrupted", expr=_current_expression())
    except Exception:
        pass
    try:
        _cg.drive_event("interrupt", 1.0)
    except Exception:
        pass
    try:
        import reflection as _rf
        _rf.on_user_reaction(kind="dismissed")
    except Exception:
        pass


def on_speech(text: str, salience: float = 0.6):

    try:
        _dc.get_drive_client().speech(text, salience)
    except Exception:
        pass


def _on_outcome(outcome: str, text: str = ""):
    if outcome != "ignored":
        return
    try:
        _dc.get_drive_client().reward(-0.2, why="she_spoke_but_ignored",
                                      expr=_current_expression())
    except Exception:
        pass


def _register_reflection_hook():
    global _HOOK_REGISTERED
    if _HOOK_REGISTERED:
        return
    try:
        import reflection as _rf
        _rf.set_outcome_hook(_on_outcome)
        _HOOK_REGISTERED = True
    except Exception:
        pass


def on_percept(text: str, salience: float = 0.6):

    try:
        _dc.get_drive_client().percept(text, salience)
    except Exception:
        pass
    try:
        _cg.drive_event("novelty", _c01(salience))
    except Exception:
        pass
    try:
        import habituation as _hab
        _hab.stimulate("vision:" + (text or ""), strength=_c01(salience))
    except Exception:
        pass
    try:
        import capsule_field as _cf
        if not _abl("capsule-field") and salience >= 0.4:
            _cf.learn(text or "", confidence=min(1.0, _c01(salience)), source="percept")
    except Exception:
        pass
    try:
        import intent as _it
        if salience >= 0.5:
            _it.form(n_obs=1)
    except Exception:
        pass


def on_praise():

    try:
        _dc.get_drive_client().stimulate("praise", 0.7)
    except Exception:
        pass
    try:
        _cg.drive_event("praise", 1.0)
    except Exception:
        pass


def on_visual_change(amp: float = 0.5):
    try:
        _dc.get_drive_client().stimulate("vision", amp)
    except Exception:
        pass


def _current_expression() -> str | None:
    try:
        return emotion().get("expression")
    except Exception:
        return None


def emotion() -> dict:

    drv = _dc.latest_drive_state()
    if not drv.fresh:
        return {"expression": "neutral", "label": None,
                "axes": {"valence": 0.0, "arousal": 0.0, "tension": 0.0, "satiety": 0.0},
                "source": "fallback"}
    axes = {k: (v if math.isfinite(v) else 0.0)
            for k, v in (drv.axes or {}).items() if isinstance(v, (int, float))}
    face = _persona.face_reply(axes)
    return {"expression": face["expression"], "label": None,
            "axes": axes, "source": "brain+persona",
            "brain_label": (drv.emotion or {}).get("label")}


def status() -> dict:
    drv = _dc.latest_drive_state()
    with LOCK:
        return {"drive": drv.summary(), "last": dict(_LAST),
                "tokens": len(_TOKENS), "thresholds": TH}


import json as _json_ut
from pathlib import Path as _Path_ut
import time as _time_ut

_UTIL_FALLBACK = {
    "enabled": True,
    "threshold": 0.58,
    "hysteresis": 0.06,
    "weights": {
        "drive": 0.24, "goal": 0.16, "novelty": 0.18, "social": 0.20,
        "intrusion": 0.34, "risk": 0.30, "delay": 0.14,
    },
    "quiet_hours": [[1, 7]],
    "hourly_proactive_cap": 8,
    "min_proactive_gap_s": 20.0,
    "uncertainty_floor": 0.35,
    "arousal_gate": 0.18,
}


def _abl(component: str) -> bool:

    try:
        cfg = _json_ut.loads(
            (_Path_ut(__file__).resolve().parent.parent / "config.json").read_text(encoding="utf-8"))
        return bool(((cfg.get("mind") or {}).get("ablation") or {}).get(component, False))
    except Exception:
        return False


def _util_cfg() -> dict:

    out = dict(_UTIL_FALLBACK)
    out["weights"] = dict(_UTIL_FALLBACK["weights"])
    try:
        cfg = _json_ut.loads(
            (_Path_ut(__file__).resolve().parent.parent / "config.json").read_text(encoding="utf-8"))
        u = ((cfg.get("mind") or {}).get("utility") or {})
        if isinstance(u.get("enabled"), bool):
            out["enabled"] = u["enabled"]
        for k in ("threshold", "hysteresis", "hourly_proactive_cap",
                  "min_proactive_gap_s", "uncertainty_floor", "arousal_gate"):
            if isinstance(u.get(k), (int, float)):
                out[k] = float(u[k])
        for k, v in (u.get("weights") or {}).items():
            if k in out["weights"] and isinstance(v, (int, float)):
                out["weights"][k] = float(v)
        if isinstance(u.get("quiet_hours"), list):
            out["quiet_hours"] = u["quiet_hours"]
    except Exception:
        pass
    try:
        if not _abl("adaptation"):
            import adaptation as _ad
            out["weights"], out["threshold"] = _ad.apply_to_weights(
                out["weights"], out["threshold"])
    except Exception:
        pass
    return out


def _c01(x) -> float:
    try:
        v = float(x)
        return min(1.0, max(0.0, v)) if math.isfinite(v) else 0.0
    except Exception:
        return 0.0


def _in_quiet_hours(now: float, windows) -> bool:
    try:
        hh = _time_ut.localtime(now).tm_hour
        for w in windows or []:
            if not isinstance(w, (list, tuple)) or len(w) < 2:
                continue
            a, b = int(w[0]), int(w[1])
            if a <= b:
                if a <= hh < b:
                    return True
            else:
                if hh >= a or hh < b:
                    return True
    except Exception:
        pass
    return False


def utility_scores(kind: str, *, addressing: bool = False, text: str = "",
                   urgency: float = 0.0) -> dict:

    cfg = _util_cfg()
    w = cfg["weights"]
    now = _time_ut.time()
    drives = _cg.drives_snapshot()
    drv = _dc.latest_drive_state()
    snap = _cg.snapshot()

    if _abl("drives"):
        d_speak, d_wait, d_ack = 0.30, 0.30, 0.30
    else:
        d_speak = (0.45 * drives.get("social", 0) + 0.35 * drives.get("curiosity", 0)
                   + 0.20 * drives.get("achievement", 0))
        d_wait = (0.70 * drives.get("rest", 0) + 0.30 * (1 - drives.get("boredom", 0)))
        d_ack = 0.5 * d_speak + 0.5 * d_wait

    goal_press = 0.20
    if snap.get("task_active") or snap.get("instruction_guard_until", 0) > now:
        goal_press = 1.0
    elif snap.get("task_goal"):
        goal_press = 0.5

    recall = _c01(drv.recall_strength) if drv.fresh else 0.5
    obs = snap.get("pending_observations") or []
    obs = [o for o in obs if not str(o.get("text", "")).startswith("[self]")]
    n_obs = len(obs)
    semantic_novel = _c01(0.40 * (1 - recall) + 0.30 * min(1.0, n_obs / 3.0)
                          + 0.30 * drives.get("boredom", 0))
    arousal = _c01(drv.speak) if drv.fresh else 0.5
    novelty = _c01(semantic_novel * (0.40 + 0.60 * arousal))
    try:
        import habituation as _hab
        if obs and not _abl("habituation"):
            last_text = str(obs[-1].get("text") or "")
            novelty = _c01(novelty * _hab.visual_factor(last_text))
    except Exception:
        pass
    try:
        import capsule_field as _cf
        if not _abl("capsule-field"):
            novelty = _c01(_cf.field_factor(novelty, text or ""))
    except Exception:
        pass

    since_user = (now - snap["last_user_ts"]) if snap.get("last_user_ts", 0) > 0 else 1800.0
    social_val = _c01((0.70 if addressing else 0.25)
                      + 0.30 * min(1.0, since_user / 1800.0)
                      + min(0.3, max(0.0, float(urgency))))

    intrusion = 0.0
    if kind != "reply" and snap.get("turn_state") != "idle":
        intrusion += 0.30
    if snap.get("tts_playing"):
        intrusion += 0.25
    if snap.get("asr_busy"):
        intrusion += 0.20
    if snap.get("task_active"):
        intrusion += 0.30
    if snap.get("instruction_guard_until", 0) > now:
        intrusion += 0.30
    if _in_quiet_hours(now, cfg.get("quiet_hours")):
        intrusion += 0.50
    try:
        budget = _cg.proactive_budget_used()
        cap = max(1, int(cfg["hourly_proactive_cap"]))
        intrusion += 0.30 * (budget / cap)
    except Exception:
        pass
    if kind == "reply":
        intrusion *= 0.45
    intrusion = _c01(intrusion)

    uncertainty = cfg.get("uncertainty_floor", 0.35) if not drv.fresh else 0.0
    risk = _c01(uncertainty)

    last_pa = snap.get("last_proactive_ts", 0)
    since_pa = (now - last_pa) if last_pa > 0 else 3600.0
    delay = _c01(min(1.0, since_pa / 1800.0))

    U = {
        "speak": (w["drive"] * d_speak + w["goal"] * goal_press + w["novelty"] * novelty
                  + w["social"] * social_val - w["intrusion"] * intrusion
                  - w["risk"] * risk + w["delay"] * delay),
        "ack":   (w["drive"] * d_ack + 0.30 * w["social"] * social_val
                  - 0.40 * w["intrusion"] * intrusion - 0.50 * w["risk"] * risk
                  + 0.30 * w["delay"] * delay),
        "wait":  (w["drive"] * d_wait - w["delay"] * delay
                  - 0.20 * w["intrusion"] * intrusion),
    }
    U = {k: round(float(v), 4) for k, v in U.items()}
    return {
        "U": U,
        "terms": {"drive": round(d_speak, 3), "goal": round(goal_press, 3),
                  "novelty": round(novelty, 3), "social": round(social_val, 3),
                  "intrusion": round(intrusion, 3), "risk": round(risk, 3),
                  "delay": round(delay, 3), "drives": drives, "quiet": _in_quiet_hours(now, cfg.get("quiet_hours"))},
    }


def utility_decide(kind: str, *, addressing: bool = False, text: str = "",
                   urgency: float = 0.0) -> tuple[str, float, str, dict]:

    cfg = _util_cfg()
    if not cfg["enabled"]:
        act, drv, reason = _decide_reply(addressing=addressing, text=text,
                                         urgency=urgency) if kind == "reply" else (
            "speak", _dc.latest_drive_state().speak, "utility_disabled")
        return act, drv, f"utility_disabled:{reason}", {}

    try:
        r = utility_scores(kind, addressing=addressing, text=text, urgency=urgency)
        U = r["U"]
        thr = float(cfg["threshold"])
        drv = _dc.latest_drive_state()
        if drv.speaking:
            thr -= float(cfg["hysteresis"])

        try:
            import evolution as _ev
            _bonus = 0.10
            try:
                import intent as _it
                _bonus = float(_it._cfg()["consistency_bonus"])
            except Exception:
                pass
            if _abl("evolution"):
                best = max(U, key=U.get)
                score = float(U[best])
                chosen_by, ibias = "utility", 0.0
            else:
                _d = _ev.decide_action(U, context={"kind": kind, "addressing": addressing},
                                       bonus=_bonus)
                best = _d["action"]
                score = float(_d["score"])
                chosen_by, ibias = _d["chosen_by"], _d["intent_bias"]
        except Exception:
            best = max(U, key=U.get)
            score = float(U[best])
            chosen_by, ibias = "fallback", 0.0

        arousal_gate = float(cfg.get("arousal_gate", 0.18))
        arousal_blocked = (
            kind in ("vision", "idle") and drv.fresh and drv.speak < arousal_gate
            and not _abl("brain-gate")
        )
        reason = (f"utility:{chosen_by}:{best}={score:.3f}"
                  f"{'>=' if score >= thr else '<'}thr={thr:.2f}")
        if abs(ibias) > 1e-6:
            reason += f"+intent={ibias:.2f}"
        if arousal_blocked:
            reason += f"+arousal_gate({drv.speak:.2f}<{arousal_gate})"

        detail = dict(r["terms"])
        detail["threshold"] = round(thr, 3)
        detail["action"] = best
        detail["chosen_by"] = chosen_by
        detail["intent_bias"] = round(ibias, 4)
        try:
            import intent as _it
            _ic = _it.current()
            detail["intent"] = {"type": _ic.get("type"), "strength": _ic.get("strength")}
        except Exception:
            pass
        if score < thr or arousal_blocked:
            action = "ack" if addressing else "silent"
            return action, round(score, 3), reason + "→" + action, detail
        action = best if best in ("speak", "ack") else "silent"
        return action, round(score, 3), reason, detail
    except Exception as e:
        return "silent", 0.0, f"utility_error:{type(e).__name__}", {}

_register_reflection_hook()
