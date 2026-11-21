from __future__ import annotations

import asyncio
import base64
import datetime
import io
import json
import os
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Optional

try:
    import secret_store
except Exception:
    secret_store = None

_CFG_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")


def _cfg_dict() -> dict:

    if secret_store is not None:
        try:
            return secret_store.load_config(_CFG_PATH)
        except Exception:
            pass
    try:
        with open(_CFG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

try:
    from PIL import Image
    _HAS_PIL = True
except Exception:
    Image = None
    _HAS_PIL = False

try:
    import numpy as np
    _HAS_NUMPY = True
except Exception:
    np = None
    _HAS_NUMPY = False


def _cfg_free(key: str, default: Any = None) -> Any:

    try:
        free = (_cfg_dict().get("vision") or {}).get("free") or {}
        return free.get(key, default)
    except Exception:
        return default


def _cfg_fallback() -> dict:

    fb = _cfg_free("fallback", None)
    return fb if isinstance(fb, dict) else {}


MAX_OBSERVATIONS = int(_cfg_free("max_observations", 5) or 5)
def _speak_min_interval_s() -> float:

    try:
        return float(_cfg_free("speak_min_interval_s", 12) or 12)
    except Exception:
        return 12.0


def _speak_max_age_s() -> float:

    try:
        return float(_cfg_free("speak_max_age_s", 20) or 20)
    except Exception:
        return 20.0


def _dprint(*args, **kwargs):

    try:
        import neuro_server as _ns
        _ns.dprint(*args, **kwargs)
    except Exception:
        pass


def _cfg_distill(key: str, default):

    try:
        d = ((_cfg_dict().get("vision") or {}).get("free") or {}).get("distill") or {}
        return d.get(key, default)
    except Exception:
        return default


def _journal_path() -> str:

    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, "..", "memory", "vision_journal.jsonl")


_DISTILL_SYSTEM_PROMPT = (
    "You are Neuro, a desktop pet, writing private notes about user based on "
    "what your eyes saw on his screen. Below are objective captions of his "
    "screen activity (oldest first). Decide what is worth remembering, then "
    "condense it. Rules:\n"
    "1. First person, English, each memory on its own line starting with '- '. "
    "NEVER start with 'He'/'She'/'They' - always 'I ...' or 'user ...'. "
    "ONE short sentence, at most 20 words; never a long description.\n"
    "2. IMPORTANT (always remember, importance 6): a coherent ongoing project "
    "or task - coding a feature, writing a paper, designing an engine, a "
    "multi-step workflow he keeps returning to, milestones reached.\n"
    "3. ORDINARY (remember only briefly, importance 3): a single window, one "
    "short action, watching a video, reading one page - forgettable unless it "
    "recurs.\n"
    "4. TRIVIAL / noise: switching windows, a momentary glance, console "
    "output, the pet's own overlay. Output nothing for these - they are "
    "forgotten.\n"
    "5. Do NOT invent anything the captions do not mention.\n"
    "6. After the '- ' lines, output ONE more line: '# keywords: w1, w2, w3' "
    "with 3-6 short keywords capturing what he is working on (for later "
    "recall). If you output nothing (all trivial), skip this line too.\n"
    "7. Output ONLY the '- ' lines and the '# keywords:' line, nothing else."
)


SPEAK_MIN_INTERVAL_S = _speak_min_interval_s()
SPEAK_MAX_AGE_S = _speak_max_age_s()
OBS_DUP_SIM = float(_cfg_free("observation_dup_similarity", 0.82) or 0.82)
OBS_DUP_WINDOW_S = float(_cfg_free("observation_dup_window_s", 90) or 90)

_VISION_SYSTEM_PROMPT = (
    "You are the eyes of a desktop pet. You are given a screenshot of the user's screen. "
    "Describe ONLY what is objectively visible, in 1-2 short English sentences. "
    "Mention the active application/window, and the concrete content (file names, page titles, "
    "text that is actually legible, dialogs, errors, whether a video is playing). "
    "Do NOT guess the user's intent, do NOT give advice, do NOT use markdown, "
    "do NOT say 'the screenshot shows'. If the screen is a plain desktop or you cannot "
    "make out anything meaningful, reply exactly: nothing notable."
)

_VISION_PROACTIVE_PROMPT = (
    "You are the eyes of a desktop pet, quietly watching user's screen while he works. "
    "Describe what he is DOING, in 1-2 short English sentences: the application in "
    "front of him and the activity in it (reading a page, watching a video, writing "
    "code, playing a game, chatting with someone). Name a title or filename only when "
    "it is the subject of that activity. "
    "Go one level deeper than 'editing a file': say what the activity actually is - "
    "scrolling through a document, typing a new paragraph, reading a section, "
    "switching between windows, dragging a selection, filling a form. "
    "If the same document stays open, describe the CHANGE or the current action "
    "rather than repeating that the document is open. "
    "Your subject is his activity, not the characters printed in utility windows. "
    "Console output, log lines, error dumps, driver warnings, launch scripts, and "
    "the pet's own overlay are background, never his activity - they belong to the "
    "pet's own process. If a console, terminal, log or launcher window fills or "
    "dominates the screen, that is an idle screen: reply exactly: nothing notable. "
    "There is a window titled 'Neuro Chat Room' (or starting with 'Neuro Chat'): "
    "that is YOUR OWN room - your own chat room with user, it belongs to the pet's "
    "own process. When he is using it, that is the two of you talking, not his "
    "work; treat it as background of your own, never report its content back "
    "as his activity. Do NOT recite or echo anything written inside it. "
    "Do NOT guess his intent, do NOT give advice, do NOT use markdown, do NOT say "
    "'the screenshot shows'. If the screen is a plain desktop, idle, or you cannot "
    "make out anything meaningful, reply exactly: nothing notable."
)

_VISION_ASK_SUFFIX = (
    "\n\nNow answer this specific question about the screenshot, in English, "
    "in one short sentence, based only on what you can actually see:\n"
)


def _similar(a: str, b: str) -> float:

    ta = set((a or "").lower().split())
    tb = set((b or "").lower().split())
    if not ta or not tb:
        return 0.0
    inter = len(ta & tb)
    union = len(ta | tb)
    return inter / union if union else 0.0


def _frame_diff_ratio(prev_sig, cur_sig) -> float:

    if prev_sig is None or cur_sig is None:
        return 1.0
    if not (_HAS_NUMPY and _HAS_PIL):
        return 1.0
    if prev_sig.shape != cur_sig.shape:
        return 1.0
    return float(np.abs(cur_sig.astype(np.int16) - prev_sig.astype(np.int16)).mean() / 255.0)


def _frame_signature(jpeg_bytes: bytes):

    if not (_HAS_PIL and _HAS_NUMPY) or not jpeg_bytes:
        return None
    try:
        img = Image.open(io.BytesIO(jpeg_bytes)).convert("L").resize((32, 32))
        return np.asarray(img, dtype=np.uint8)
    except Exception:
        return None


def _downscale_jpeg(jpeg_bytes: bytes, max_side: int = 768) -> bytes:

    if not (_HAS_PIL and jpeg_bytes):
        return jpeg_bytes
    try:
        _cfg_max = int(_cfg_free("downscale_max_side", max_side) or max_side)
        max_side = max(256, min(2048, _cfg_max))
    except Exception:
        pass
    try:
        img = Image.open(io.BytesIO(jpeg_bytes))
        w, h = img.size
        longest = max(w, h)
        if longest <= max_side:
            return jpeg_bytes
        ratio = max_side / float(longest)
        nw, nh = max(1, int(round(w * ratio))), max(1, int(round(h * ratio)))
        img = img.resize((nw, nh), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=80)
        return buf.getvalue()
    except Exception:
        return jpeg_bytes


def _jpeg_to_data_url(jpeg_bytes: bytes) -> str:

    jpeg_bytes = _downscale_jpeg(jpeg_bytes)
    b64 = base64.b64encode(jpeg_bytes).decode("ascii")
    return "data:image/jpeg;base64," + b64


class Observation:

    __slots__ = ("text", "at", "source", "count")

    def __init__(self, text: str, at: float, source: str = "proactive", count: int = 1):
        self.text = text
        self.at = at
        self.source = source
        self.count = count

    def to_dict(self) -> dict:
        return {"text": self.text, "at": self.at, "source": self.source,
                "count": self.count}


class VisionManager:

    def __init__(self, on_speech: Optional[Callable[[str, dict], None]] = None,
                 on_status: Optional[Callable[[dict], None]] = None):

        self.on_speech = on_speech
        self.on_status = on_status

        self._running = False
        self._inflight = False
        self._pending_frame: Optional[bytes] = None
        self._tasks: set = set()

        self.observations: list = []

        self._frame_index = 0
        self._frame_seq = 0
        self._frames_skipped = 0
        self._last_frame_at = 0.0
        self._last_call_at = 0.0
        self._last_sig = None
        self._last_error = ""
        self._calls_ok = 0
        self._calls_fail = 0
        self._latest_jpeg: Optional[bytes] = None

        self._journal_pending: list = []
        self._last_distill_at = 0.0
        self._distill_inflight = False

        self._keywords: list = []

        self._t0 = time.time()
        self.enabled = bool(_cfg_free("enabled", False))
        self.autopush = bool(_cfg_free("auto_push_frames", True))
        self.fps = float(_cfg_free("fps", 1.0) or 1.0)
        self.max_observations = int(_cfg_free("max_observations", MAX_OBSERVATIONS) or MAX_OBSERVATIONS)


    @property
    def api_key(self) -> str:

        return (str(_cfg_free("api_key", "") or "").strip()
                or os.environ.get("ZHIPUAI_API_KEY", "")
                or os.environ.get("NEURO_VISION_FREE_KEY", ""))

    @property
    def active(self) -> bool:

        return bool(self._running and self.enabled and self.api_key)

    def status(self) -> dict:
        return {
            "enabled": self.enabled,
            "running": self._running,
            "connected": self.active,
            "autopush": self.autopush,
            "fps": self.fps,
            "frames": self._frame_seq,
            "frames_seen": self._frame_index,
            "frames_skipped": self._frames_skipped,
            "calls_ok": self._calls_ok,
            "calls_fail": self._calls_fail,
            "observations": len(self.observations),
            "has_key": bool(self.api_key),
            "min_interval_s": float(_cfg_free("min_interval_s", 6) or 6),
            "change_threshold": float(_cfg_free("change_threshold", 0.06) or 0.06),
            "last_error": self._last_error,
            "model": _cfg_free("model", "glm-4v-flash"),
        }

    def _emit_status(self, **kw):
        if self.on_status:
            try:
                self.on_status(kw)
            except Exception:
                pass


    async def start(self) -> bool:

        self.enabled = bool(_cfg_free("enabled", False))
        if not self.enabled:
            self._emit_status(state="disabled")
            return False
        if not self.api_key:
            self._emit_status(
                state="no_key",
                message="未配置免费视觉 API Key（config.json → vision.free.api_key，"
                        "或环境变量 ZHIPUAI_API_KEY）",
            )
            return False
        self._running = True
        self.enabled = True
        self.autopush = bool(_cfg_free("auto_push_frames", True))
        self.fps = float(_cfg_free("fps", 1.0) or 1.0)
        self.max_observations = int(_cfg_free("max_observations", MAX_OBSERVATIONS) or MAX_OBSERVATIONS)
        self._emit_status(state="connected",
                          model=_cfg_free("model", "glm-4v-flash"))
        return True

    async def stop(self):

        self._running = False
        for t in list(self._tasks):
            try:
                t.cancel()
            except Exception:
                pass
        self._tasks.clear()
        self._inflight = False
        self._emit_status(state="stopped")


    async def push_frame(self, jpeg_bytes: bytes) -> bool:

        if not self.active:
            return False
        if not jpeg_bytes:
            return False

        self._frame_index += 1
        self._last_frame_at = time.time()
        self._latest_jpeg = jpeg_bytes

        try:
            if self._journal_pending and not self._distill_inflight:
                _iv = float(_cfg_distill("interval_s", 300) or 300)
                if time.time() - self._last_distill_at >= _iv:
                    self._emit_status(state="distill_timer",
                                      wait=round(time.time() - self._last_distill_at, 0))
                    self._maybe_distill()
        except Exception:
            pass

        if not self.autopush:
            return False

        sig = _frame_signature(jpeg_bytes)
        threshold = float(_cfg_free("change_threshold", 0.06) or 0.06)
        ratio = _frame_diff_ratio(self._last_sig, sig)
        if self._last_sig is not None and ratio < threshold:
            self._frames_skipped += 1
            return False

        min_interval = float(_cfg_free("min_interval_s", 6) or 6)
        now = time.time()
        if self._last_call_at and (now - self._last_call_at) < min_interval:
            self._frames_skipped += 1
            self._emit_status(state="throttled",
                              wait=round(min_interval - (now - self._last_call_at), 2))
            return False

        if self._inflight:
            self._frames_skipped += 1
            self._pending_frame = jpeg_bytes
            return False

        self._last_sig = sig
        self._last_call_at = now
        self._frame_seq += 1
        self._emit_status(state="observing", ratio=round(ratio, 4),
                          frames=self._frame_seq)
        self._spawn(self._observe(jpeg_bytes))
        return True

    async def _observe(self, jpeg_bytes: bytes, _catchup=False):

        self._inflight = True
        try:
            _vis_timeout = float(_cfg_free("api_timeout_s", 8) or 8)
            text = await asyncio.wait_for(
                asyncio.to_thread(self._call_vision_api, jpeg_bytes, None),
                timeout=_vis_timeout + 2.0)
            if not text:
                return
            text = text.strip()
            if _is_nothing_notable(text):
                self._emit_status(state="nothing_notable")
                return
            is_new = self._add_observation(text, source="proactive")
            if is_new:
                self._record_activity(text)
                if self.on_speech:
                    try:
                        self.on_speech(text, {"source": "proactive", "at": time.time()})
                    except Exception as e:
                        self._emit_status(state="error", message=str(e))
                self._maybe_distill()
        except Exception as e:
            self._last_error = str(e)
            self._emit_status(state="observe_error", message=str(e))
        finally:
            self._inflight = False
            pending = self._pending_frame
            self._pending_frame = None
            if pending and not _catchup and self._running:
                _gap = float(_cfg_free("min_interval_s", 1.0) or 1.0)
                if (time.time() - (self._last_call_at or 0.0)) >= _gap:
                    self._spawn(self._observe(pending, _catchup=True))

    async def ask(self, question: str, timeout: float = 25.0) -> str:

        if not self.active:
            return ""
        frame = self._latest_jpeg
        if not frame:
            return ""
        q = (question or "").strip() or "What is on the screen?"
        try:
            text = await asyncio.wait_for(
                asyncio.to_thread(self._call_vision_api, frame, q),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            self._emit_status(state="ask_timeout")
            return ""
        except Exception as e:
            self._emit_status(state="ask_error", message=str(e))
            return ""
        text = (text or "").strip()
        if text and not _is_nothing_notable(text):
            self._add_observation(text, source="asked")
            return text
        return ""

    async def verify_cursor(self, x: int, y: int, timeout: float = 25.0) -> dict:

        if not self.active:
            return {"ok": False, "reason": "vision_inactive"}
        frame = self._latest_jpeg
        if not frame:
            return {"ok": False, "reason": "no_frame"}
        q = (
            f"In this screenshot, what is located at or near the pixel coordinate "
            f"({int(x)},{int(y)})? Name the concrete UI element or text there "
            f"(button label, input box, window title, icon, blank desktop...). "
            f"If it is blank/empty desktop or nothing meaningful, reply exactly: blank."
        )
        try:
            text = await asyncio.wait_for(
                asyncio.to_thread(self._call_vision_api, frame, q),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            return {"ok": False, "reason": "timeout"}
        except Exception as e:
            return {"ok": False, "reason": "error", "detail": str(e)}
        text = (text or "").strip()
        if not text:
            return {"ok": False, "reason": "empty"}
        return {"ok": True, "text": text}

    async def verify_ime(self, timeout: float = 25.0) -> dict:

        if not self.active:
            return {"ok": False, "reason": "vision_inactive"}
        frame = self._latest_jpeg
        if not frame:
            return {"ok": False, "reason": "no_frame"}
        q = (
            "Look at the whole screenshot. What is the CURRENT INPUT METHOD "
            "(IME) state of this Windows system? Look at the language bar / "
            "taskbar tray indicator (usually bottom-right), any IME popup, or "
            "the status icon. Reply with ONE of exactly: 'chinese' / 'english' / "
            "'unknown'. Base it ONLY on what is actually visible - a '中' or "
            "'拼' or Chinese candidate window means chinese; 'EN' or 'ENG' or "
            "'A' means english. If you cannot tell, reply: unknown."
        )
        try:
            text = await asyncio.wait_for(
                asyncio.to_thread(self._call_vision_api, frame, q),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            return {"ok": False, "reason": "timeout"}
        except Exception as e:
            return {"ok": False, "reason": "error", "detail": str(e)}
        text = (text or "").strip().lower()
        if not text:
            return {"ok": False, "reason": "empty"}
        if "chinese" in text or "中文" in text or "拼音" in text or "中" == text:
            return {"ok": True, "ime": "chinese", "text": text}
        if "english" in text or "英文" in text or text.startswith("en"):
            return {"ok": True, "ime": "english", "text": text}
        return {"ok": False, "reason": "ambiguous", "text": text}


    def _call_vision_api(self, jpeg_bytes: bytes, question: Optional[str]) -> str:

        primary = {
            "api_url": (_cfg_free("api_url", "") or "").strip(),
            "api_key": self.api_key,
            "model": (_cfg_free("model", "glm-4v-flash") or "glm-4v-flash").strip(),
        }
        text, err = self._post_vision(primary, jpeg_bytes, question)
        if text:
            self._calls_ok += 1
            self._last_error = ""
            return text

        fb = _cfg_fallback()
        fb_url = str(fb.get("api_url") or "").strip()
        fb_key = str(fb.get("api_key") or "").strip() or os.environ.get("SILICONFLOW_API_KEY", "")
        if fb_url and fb_key:
            fb_cfg = {"api_url": fb_url, "api_key": fb_key,
                      "model": str(fb.get("model") or "Qwen/Qwen3-VL-8B-Instruct")}
            text, err2 = self._post_vision(fb_cfg, jpeg_bytes, question)
            if text:
                self._calls_ok += 1
                self._emit_status(state="fallback_ok")
                self._last_error = ""
                return text
            err = f"{err} | fallback: {err2}"

        self._calls_fail += 1
        self._last_error = err or "unknown"
        self._emit_status(state="vision_error", message=self._last_error)
        return ""

    def _post_vision(self, cfg: dict, jpeg_bytes: bytes, question: Optional[str]):

        url = cfg.get("api_url") or ""
        key = cfg.get("api_key") or ""
        model = cfg.get("model") or ""
        if not url or not key:
            return "", "missing api_url/api_key"

        user_text = (
            _VISION_PROACTIVE_PROMPT if not question else
            _VISION_SYSTEM_PROMPT + " " + _VISION_ASK_SUFFIX + question)
        body = {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url",
                         "image_url": {"url": _jpeg_to_data_url(jpeg_bytes)}},
                        {"type": "text", "text": user_text},
                    ],
                }
            ],
            "stream": False,
            "max_tokens": int(_cfg_free("max_tokens", 256) or 256),
            "temperature": 0.2,
        }
        req = urllib.request.Request(
            url.rstrip("/") + "/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {key}",
            },
            method="POST",
        )
        try:
            _vis_timeout = float(_cfg_free("api_timeout_s", 8) or 8)
            with urllib.request.urlopen(req, timeout=_vis_timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "ignore")[:300]
            except Exception:
                pass
            return "", f"HTTP {e.code}: {detail}"
        except Exception as e:
            return "", f"{type(e).__name__}: {e}"

        msg = ((data.get("choices") or [{}])[0].get("message") or {})
        content = (msg.get("content") or "").strip()
        if not content:
            if isinstance(msg.get("content"), list):
                content = " ".join(
                    str(seg.get("text") or "") for seg in msg["content"]
                    if isinstance(seg, dict)
                ).strip()
        if not content:
            return "", "empty content"
        return content, ""


    def recent_observations(self, window_s: float = 60.0, limit: int = 4) -> list:

        now = time.time()
        recent = [ob for ob in self.observations if (now - ob.at) <= window_s]
        return [ob.text for ob in recent[-limit:]]

    def _add_observation(self, text: str, source: str = "proactive") -> bool:

        text = (text or "").strip()
        if not text:
            return False
        now = time.time()
        if self.observations:
            last = self.observations[-1]
            if (now - last.at) <= OBS_DUP_WINDOW_S and \
                    _similar(text, last.text) >= OBS_DUP_SIM:
                last.count += 1
                last.at = now
                return False
        self.observations.append(Observation(text, now, source))
        try:
            import arbiter as _arb
            _arb.on_percept(text, 1.0 if source == "proactive" else 0.6)
        except Exception:
            pass
        while len(self.observations) > self.max_observations:
            self.observations.pop(0)
        return True

    def observation_context(self) -> str:

        if not self.observations:
            return ""
        now = time.time()
        window_s = float(_cfg_free("observation_context_window_s", 300) or 300)
        obs = [ob for ob in self.observations if (now - ob.at) <= window_s]
        if not obs:
            _last = self.observations[-1]
            _ago = max(0, int(now - _last.at))
            return ("\n[Your last screen observation was " + str(_ago)
                    + "s ago and is NO LONGER current. Do NOT claim you still see it "
                    "or that any app is still open. If user asks what was on screen "
                    "earlier, refer to it only as something you saw earlier.]\n"
                    "- [" + str(_ago) + "s ago, STALE] " + _last.text)
        lines = []
        for ob in obs:
            ago = max(0, int(now - ob.at))
            tag = "proactive" if ob.source == "proactive" else "asked"
            extra = f" (repeated {ob.count}x)" if ob.count > 1 else ""
            lines.append(f"- [{ago}s ago, {tag}] {ob.text}{extra}")
        kws = self.keywords()
        kws_line = ("\n" + kws) if kws else ""
        return ("\n[What you can see on user's screen right now — "
                "reported by your own eyes, NOT said by user. "
                "Use it only if it is relevant to what he asks. "
                "Never recite it verbatim.]\n" + "\n".join(lines) + kws_line)

    def clear_observations(self):
        self.observations = []

    def keywords(self) -> str:

        if not self._keywords:
            return ""
        return "This session's screen themes: " + ", ".join(self._keywords) + "."


    def _record_activity(self, text: str):

        try:
            rec = {"at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                   "text": text}
            p = _journal_path()
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            self._journal_pending.append((time.time(), text))
        except Exception as e:
            self._emit_status(state="journal_error", message=str(e))

    def _maybe_distill(self):

        pending = self._journal_pending
        if not pending or self._distill_inflight:
            return
        n = int(_cfg_distill("every_n", 10) or 10)
        interval = float(_cfg_distill("interval_s", 1800) or 1800)
        due = len(pending) >= n or (time.time() - self._last_distill_at) >= interval
        if not due:
            return
        self._distill_inflight = True
        self._spawn(self._distill_activity(list(pending)))

    async def _distill_activity(self, items: list):

        try:
            import agent_bridge as ab
            if getattr(ab, "_GATE_INFLIGHT", False):
                return
            cfg = ab.load_cfg()
            lines = "\n".join(f"- {t}" for _, t in items)
            msgs = [
                {"role": "system", "content": _DISTILL_SYSTEM_PROMPT},
                {"role": "user", "content": "Screen activity captions:\n" + lines},
            ]
            out = await asyncio.to_thread(
                ab.llm_complete, cfg, msgs, 300)
            out = (out or "").strip()
            added = 0
            if out:
                try:
                    import memory_system as ms
                    kws: list = []
                    for raw in out.splitlines():
                        line = raw.strip()
                        if line.startswith("# keywords"):
                            kws = [k.strip().lstrip("- ").strip()
                                   for k in line.split(":", 1)[1].split(",")
                                   if k.strip()]
                            continue
                        t = line.lstrip("- ").strip()
                        if len(t) < 12 or not t.startswith(("I ", "user", "He ")):
                            continue
                        if t.startswith("He "):
                            continue
                        try:
                            import memory_system as _ms0
                            _cap = getattr(_ms0, "MAX_FRAGMENT_CHARS", 120)
                        except Exception:
                            _cap = 120
                        try:
                            import memory_system as _ms1
                            t = _ms1.trim_fragment(t, _cap)
                        except Exception:
                            t = t[:_cap].strip()
                        important = ("IMPORTANT" in line
                                     or line.startswith("[imp]")
                                     or "building" in t.lower()
                                     or "working on" in t.lower()
                                     or "project" in t.lower())
                        importance = 6 if important else 3
                        tags = (["theme:日常", "emotion:中性"]
                                if important else
                                ["theme:日常", "emotion:中性", "vision:ephemeral"])
                        if ms.add_fragment(t, tags=tags, importance=importance):
                            added += 1
                        if added >= 3:
                            break
                    if kws:
                        for k in kws[:6]:
                            if k and k not in self._keywords:
                                self._keywords.append(k)
                        _dprint(f"[vision] 会话关键词: {self._keywords}", flush=True)
                except Exception as e:
                    self._emit_status(state="distill_write_error", message=str(e))
            self._last_distill_at = time.time()
            self._journal_pending = []
            self._emit_status(state="distilled", memories=added, from_obs=len(items))
        except Exception as e:
            self._last_distill_at = time.time()
            self._emit_status(state="distill_error", message=str(e))
        finally:
            self._distill_inflight = False


    def mark_start(self):

        self._t0 = time.time()
        self._last_sig = None
        self._last_call_at = 0.0
        self._keywords = []

    def _spawn(self, coro):

        try:
            task = asyncio.ensure_future(coro)
        except Exception:
            return
        self._tasks.add(task)
        task.add_done_callback(lambda t: self._tasks.discard(t))


def _is_nothing_notable(text: str) -> bool:

    t = (text or "").strip().lower().strip(".。!")
    if not t:
        return True
    return t in ("nothing notable", "nothing", "no notable", "nothing to note",
                 "没有值得注意的", "无", "nothing noteworthy")
