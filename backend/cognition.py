# -*- coding: utf-8 -*-


import re
import time
import threading

_WM_LOCK = threading.RLock()

TS_IDLE = "idle"
TS_LISTENING = "listening"
TS_THINKING = "thinking"
TS_SPEAKING = "speaking"

_WM = {
    "turn_state": TS_IDLE,
    "last_user_ts": 0.0,
    "last_neuro_ts": 0.0,
    "last_tts_end_ts": 0.0,
    "tts_playing": False,

    "llm_inflight": False,
    "asr_busy": False,

    "user_voice_active": False,
    "last_voice_ts": 0.0,

    "task_active": False,
    "task_goal": "",
    "instruction_guard_until": 0.0,
    "instruction_text": "",

    "proactive_count_hour": 0,
    "proactive_hour_bucket": 0,
    "last_proactive_ts": 0.0,
    "last_proactive_text": "",

    "pending_observations": [],
}


def user_speaking(busy: bool):

    global _WM
    with _WM_LOCK:
        _WM["asr_busy"] = bool(busy)
        if busy:
            _WM["last_user_ts"] = time.time()
            _WM["turn_state"] = TS_LISTENING
        else:
            if _WM["turn_state"] == TS_LISTENING:
                _WM["turn_state"] = TS_IDLE


def user_voice_active(active: bool):

    global _WM
    with _WM_LOCK:
        _WM["user_voice_active"] = bool(active)
        if active:
            _WM["last_voice_ts"] = time.time()


def user_input(text: str = ""):

    with _WM_LOCK:
        _WM["last_user_ts"] = time.time()
        if _WM["turn_state"] in (TS_IDLE, TS_LISTENING):
            _WM["turn_state"] = TS_THINKING


def neuro_spoke(text: str = "", proactive: bool = False):

    with _WM_LOCK:
        _WM["last_neuro_ts"] = time.time()
        if proactive:
            _WM["last_proactive_ts"] = time.time()
            if text:
                _WM["last_proactive_text"] = str(text)
            _bump_hour_bucket()
            _WM["proactive_count_hour"] += 1


def tts_state(playing: bool, last_end_ts: float = 0.0):

    with _WM_LOCK:
        _WM["tts_playing"] = bool(playing)
        if playing:
            _WM["turn_state"] = TS_SPEAKING
        else:
            if last_end_ts > 0:
                _WM["last_tts_end_ts"] = float(last_end_ts)
            if _WM["turn_state"] == TS_SPEAKING:
                _WM["turn_state"] = TS_IDLE


def llm_inflight(inflight: bool):

    with _WM_LOCK:
        _WM["llm_inflight"] = bool(inflight)
        if inflight and _WM["turn_state"] in (TS_IDLE, TS_LISTENING):
            _WM["turn_state"] = TS_THINKING
        elif not inflight and _WM["turn_state"] == TS_THINKING:
            _WM["turn_state"] = TS_IDLE


def task_state(active: bool, goal: str = ""):

    was = False
    with _WM_LOCK:
        was = bool(_WM.get("task_active"))
        _WM["task_active"] = bool(active)
        _WM["task_goal"] = str(goal or "")
    try:
        if active and not was:
            drive_event("task_start", 1.0)
        elif was and not active:
            drive_event("task_done", 1.0)
    except Exception:
        pass


def set_instruction_guard(text: str, ttl_s: float = 600.0):

    with _WM_LOCK:
        _WM["instruction_guard_until"] = time.time() + max(60.0, float(ttl_s))
        _WM["instruction_text"] = str(text or "")[:200]


def instruction_guard_active() -> bool:
    with _WM_LOCK:
        return time.time() < _WM["instruction_guard_until"]


def observe(text: str):

    if not text:
        return
    with _WM_LOCK:
        _WM["pending_observations"].append({"at": time.time(), "text": str(text)})
        if len(_WM["pending_observations"]) > 20:
            del _WM["pending_observations"][:-20]


def recent_observations(window_s: float = 60.0):

    with _WM_LOCK:
        now = time.time()
        return [o for o in _WM["pending_observations"]
                if now - o["at"] <= window_s]


def _bump_hour_bucket():

    cur = time.localtime().tm_hour
    if _WM["proactive_hour_bucket"] != cur:
        _WM["proactive_hour_bucket"] = cur
        _WM["proactive_count_hour"] = 0


def proactive_budget_used() -> int:
    with _WM_LOCK:
        _bump_hour_bucket()
        return _WM["proactive_count_hour"]


def last_proactive_info():

    with _WM_LOCK:
        return _WM["last_proactive_ts"], _WM["last_proactive_text"]


def snapshot() -> dict:

    with _WM_LOCK:
        _bump_hour_bucket()
        return dict(_WM)


PROACTIVE_MIN_GAP_S = 12.0
POST_SPEAK_QUIET_S = 8.0
VOICE_TAIL_GRACE_S = 1.2


def proactive_hourly_cap() -> int:
    try:
        import json as _json
        from pathlib import Path as _Path
        _cfg = _json.loads((_Path(__file__).resolve().parent.parent
                            / "config.json").read_text(encoding="utf-8"))
        _v = ((_cfg.get("mind") or {}).get("utility") or {}).get("hourly_proactive_cap")
        if isinstance(_v, (int, float)) and _v >= 1:
            return int(_v)
    except Exception:
        pass
    return 8

_IMPERATIVE_PREFIX = re.compile(
    r"^\s*(?:请|麻烦|帮我|帮忙|给我|替我|你去|你帮|能不能帮|可以帮|"
    r"please|can you|could you|would you|go ahead and)(?![A-Za-z])", re.I)
_VERB_AT_START = re.compile(
    r"^\s*(?:写|做|改|修|删|建|创建|打开|安装|运行|执行|输入|点击|搜索|"
    r"write|create|make|build|fix|modify|edit|delete|install|run|execute|"
    r"type|open|start)(?![A-Za-z])", re.I)
_MENTION_NOT_COMMAND = re.compile(
    r"(?:觉得|认为|感觉|好像|似乎|是不是|写得|写的不错|写作|写字|写法|写手|做菜|做人|"
    r"i think|i feel|seems like|looks like|what about|how about)", re.I)
_NOT_INSTRUCTION_RE = re.compile(
    r"(?:吗|呢|么|会不会|能不能|可不可以|要不要|怎么样|如何|\?\s*$|"
    r"what|how|why|do you|can you|could you|would you|should we)\b", re.I)


def maybe_start_instruction_guard(user_text: str):

    t = (user_text or "").strip()
    if len(t) < 4:
        return False
    if _NOT_INSTRUCTION_RE.search(t):
        return False
    if _MENTION_NOT_COMMAND.search(t):
        return False
    if not (_VERB_AT_START.search(t) or _IMPERATIVE_PREFIX.search(t)):
        return False
    set_instruction_guard(t, ttl_s=600.0)
    return True


def can_speak_proactive(*, source: str = "", min_gap_s: float = None) -> (bool, str):

    now = time.time()
    with _WM_LOCK:
        snap = dict(_WM)

    if snap.get("user_voice_active"):
        return False, "user_voice_active(vad)"
    if snap.get("last_voice_ts") and (now - snap["last_voice_ts"]) < VOICE_TAIL_GRACE_S:
        return False, f"voice_tail({now - snap['last_voice_ts']:.2f}s<{VOICE_TAIL_GRACE_S}s)"

    if now < snap["instruction_guard_until"]:
        return False, f"instruction_guard({int(snap['instruction_guard_until'] - now)}s left)"

    if snap["task_active"]:
        return False, f"task_active({snap['task_goal'][:40]})"

    st = snap["turn_state"]
    if st == TS_LISTENING:
        return False, "user_speaking(asr)"
    if st == TS_THINKING and snap["llm_inflight"]:
        return False, "llm_inflight"
    if st == TS_SPEAKING and snap["tts_playing"]:
        return False, "tts_playing"

    if snap["asr_busy"]:
        return False, "asr_busy_fallback"
    if snap["llm_inflight"]:
        return False, "llm_inflight_fallback"
    if snap["tts_playing"]:
        return False, "tts_playing_fallback"
    if snap["last_tts_end_ts"] > 0:
        since_end = now - snap["last_tts_end_ts"]
        if 0 <= since_end < POST_SPEAK_QUIET_S:
            return False, f"post_speak_quiet({since_end:.1f}s<{POST_SPEAK_QUIET_S:.0f}s)"

    gap = PROACTIVE_MIN_GAP_S if min_gap_s is None else max(PROACTIVE_MIN_GAP_S, float(min_gap_s))
    last_pa = snap["last_proactive_ts"]
    if last_pa > 0 and now - last_pa < gap:
        return False, f"proactive_gap({now - last_pa:.1f}s<{gap:.0f}s)"

    _cap = proactive_hourly_cap()
    if proactive_budget_used() >= _cap:
        return False, f"hourly_budget_exhausted({_cap})"

    return True, ""


def self_state_text() -> str:

    now = time.time()
    with _WM_LOCK:
        snap = dict(_WM)

    lines = []
    since_user = now - snap["last_user_ts"] if snap["last_user_ts"] > 0 else None
    if since_user is not None and since_user < 600:
        lines.append(f"[Self] Last interaction with user: {int(since_user)}s ago.")

    if snap["task_active"] and snap["task_goal"]:
        lines.append(f"[Self] Ongoing task: {snap['task_goal']} — stay on it.")

    if now < snap["instruction_guard_until"]:
        instr = snap["instruction_text"]
        lines.append(
            "[Self] user gave you a direct instruction recently (\"" + instr + "\"). "
            "Do NOT ask whether to start, do NOT confirm again — he already said yes. "
            "Execute it now, or report progress in ONE short line if something blocks you.")
    elif snap["instruction_text"]:
        pass

    return "\n".join(lines)


def diag_line() -> str:

    s = snapshot()
    return (f"[cognition] state={s['turn_state']} asr={s['asr_busy']} "
            f"llm={s['llm_inflight']} tts={s['tts_playing']} "
            f"task={s['task_active']} guard={s['instruction_guard_until'] > time.time()} "
            f"budget={s['proactive_count_hour']}/8 "
            f"lastPA={s['last_proactive_ts']:.0f}")


import json as _json_dv
from pathlib import Path as _Path_dv
from math import exp as _exp_dv

DRIVE_NAMES = ("curiosity", "social", "rest", "order", "achievement", "boredom")

_DV_FALLBACK = {
    "enabled": True,
    "base": {"curiosity": 0.35, "social": 0.30, "rest": 0.20,
             "order": 0.15, "achievement": 0.30, "boredom": 0.20},
    "tau_s": 1800.0,
}


def _dv_cfg() -> dict:

    out = dict(_DV_FALLBACK)
    out["base"] = dict(_DV_FALLBACK["base"])
    try:
        cfg = _json_dv.loads(
            (_Path_dv(__file__).resolve().parent.parent / "config.json").read_text(encoding="utf-8"))
        d = ((cfg.get("mind") or {}).get("drives") or {})
        if isinstance(d.get("enabled"), bool):
            out["enabled"] = d["enabled"]
        for k, v in (d.get("base") or {}).items():
            if k in out["base"] and isinstance(v, (int, float)):
                out["base"][k] = min(1.0, max(0.0, float(v)))
        if isinstance(d.get("tau_s"), (int, float)) and d["tau_s"] > 1:
            out["tau_s"] = float(d["tau_s"])
    except Exception:
        pass
    return out


with _WM_LOCK:
    _WM.setdefault("drives", {n: float(_DV_FALLBACK["base"][n]) for n in DRIVE_NAMES})
    _WM.setdefault("drives_t", time.time())


def _dv_advance(now: float):

    last = float(_WM.get("drives_t") or now)
    dt = now - last
    if dt <= 0:
        _WM["drives_t"] = now
        return
    dt = min(dt, 86400.0)
    cfg = _dv_cfg()
    k = 1.0 - _exp_dv(-dt / cfg["tau_s"])
    for n in DRIVE_NAMES:
        cur = float(_WM["drives"].get(n, cfg["base"][n]))
        tgt = cfg["base"][n]
        _WM["drives"][n] = min(1.0, max(0.0, cur + (tgt - cur) * k))
    _WM["drives_t"] = now


def drives_snapshot() -> dict:

    with _WM_LOCK:
        _dv_advance(time.time())
        return {n: round(float(_WM["drives"][n]), 4) for n in DRIVE_NAMES}


def drive_set(name: str, value: float):

    if name not in DRIVE_NAMES:
        return
    with _WM_LOCK:
        _dv_advance(time.time())
        _WM["drives"][name] = min(1.0, max(0.0, float(value)))


def drive_impulse(name: str, delta: float):

    if name not in DRIVE_NAMES or not delta:
        return
    with _WM_LOCK:
        _dv_advance(time.time())
        _WM["drives"][name] = min(1.0, max(0.0, float(_WM["drives"][name]) + float(delta)))


_EVENT_IMPULSE = {
    "novelty":       {"curiosity": +0.18, "boredom": -0.22},
    "repeat":        {"boredom": +0.12, "curiosity": -0.06},
    "social_contact":{"social": -0.30, "achievement": +0.04},
    "praise":        {"achievement": +0.18, "social": -0.12},
    "interrupt":     {"order": +0.12, "social": +0.08},
    "ignored":       {"social": +0.15, "boredom": +0.10},
    "task_start":    {"order": +0.18, "achievement": +0.12, "boredom": -0.10},
    "task_done":     {"order": -0.35, "achievement": -0.32},
    "explore":       {"curiosity": -0.20, "boredom": -0.15},
    "rest":          {"rest": -0.42, "boredom": -0.08},
}


def drive_event(event: str, scale: float = 1.0):

    try:
        imp = _EVENT_IMPULSE.get(event)
        if not imp:
            return
        s = min(2.0, max(0.0, float(scale)))
        with _WM_LOCK:
            now = time.time()
            _dv_advance(now)
            for n, d in imp.items():
                if n in DRIVE_NAMES:
                    _WM["drives"][n] = min(1.0, max(0.0, _WM["drives"][n] + d * s))
    except Exception:
        pass


def drive_line() -> str:
    d = drives_snapshot()
    return "[drives] " + " ".join(f"{n[:3]}={d[n]:.2f}" for n in DRIVE_NAMES)
