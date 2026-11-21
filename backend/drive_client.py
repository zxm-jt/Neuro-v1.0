from __future__ import annotations

import json
import math
import queue
import threading
import time
import urllib.error
import urllib.request

DEFAULT_URL = "http://127.0.0.1:6007"
POLL_S = 0.2
FRESH_S = 1.5
STALE_S = 30.0
POST_TIMEOUT = 0.4


class DriveState:

    __slots__ = ("raw", "ts", "available")

    def __init__(self, raw: dict | None = None, ts: float = 0.0, available: bool = False):
        self.raw = raw or {}
        self.ts = ts
        self.available = available

    @property
    def age_s(self) -> float:
        return float("inf") if self.ts <= 0 else time.time() - self.ts

    @property
    def fresh(self) -> bool:
        return self.available and self.age_s < FRESH_S

    @property
    def stale(self) -> bool:
        return (not self.available) or self.age_s > STALE_S

    @property
    def speak(self) -> float:
        return _finite((self.raw.get("actions") or {}).get("speak", 0.0))

    @property
    def speaking(self) -> bool:
        return bool(self.raw.get("speaking", False))

    @property
    def look(self) -> float:
        return _finite((self.raw.get("actions") or {}).get("look", 0.0))

    @property
    def withdraw(self) -> float:
        return _finite((self.raw.get("actions") or {}).get("withdraw", 0.0))

    @property
    def axes(self) -> dict:
        return {k: _finite(v) for k, v in (self.raw.get("axes") or {}).items()}

    @property
    def emotion(self) -> dict:
        return dict(self.raw.get("emotion") or {})

    @property
    def recall_strength(self) -> float:
        return _finite((self.raw.get("recall") or {}).get("strength", 0.0))

    @property
    def value(self) -> float:
        return _finite(self.raw.get("value", 0.0))

    @property
    def frame(self) -> int:
        try:
            return int(self.raw.get("frame", 0) or 0)
        except Exception:
            return 0

    @property
    def sleep_pressure(self) -> float:
        return float((self.raw.get("scalars") or {}).get("sleep_pressure", 0.0))

    def summary(self) -> dict:
        return {"available": self.available,
                "age_s": (round(self.age_s, 2) if (self.ts > 0 and math.isfinite(self.age_s)) else None),
                "speak": round(self.speak, 3), "speaking": self.speaking,
                "axes": {k: round(float(v), 3) for k, v in self.axes.items()},
                "recall": round(self.recall_strength, 3), "frame": self.frame,
                "value": round(self.value, 3)}


EMPTY = DriveState()


def _finite(x, default: float = 0.0) -> float:

    try:
        v = float(x)
        return v if math.isfinite(v) else default
    except Exception:
        return default


class DriveClient:
    def __init__(self, url: str = DEFAULT_URL):
        self.url = url.rstrip("/")
        self._state = EMPTY
        self._lock = threading.Lock()
        self._q: queue.Queue = queue.Queue(maxsize=200)
        self._stop = threading.Event()
        self._thread = None
        self.fails = 0
        self.posts_ok = 0

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="drive-client", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1.5)

    def _loop(self):
        next_poll = 0.0
        while not self._stop.is_set():
            now = time.time()
            if now >= next_poll:
                self._poll()
                next_poll = now + (POLL_S if self._state.available else min(5.0, 0.5 * (2 ** min(self.fails, 4))))
            self._drain_posts()
            time.sleep(0.02)

    def _poll(self):
        try:
            with urllib.request.urlopen(self.url + "/out", timeout=0.8) as r:
                raw = json.loads(r.read().decode("utf-8"))
            with self._lock:
                self._state = DriveState(raw, time.time(), True)
            self.fails = 0
        except Exception:
            self.fails += 1
            with self._lock:
                self._state = DriveState(self._state.raw, self._state.ts, False)

    def _drain_posts(self):
        for _ in range(3):
            try:
                path, payload = self._q.get_nowait()
            except queue.Empty:
                return
            try:
                data = json.dumps(payload).encode("utf-8")
                req = urllib.request.Request(self.url + path, data=data,
                                             headers={"Content-Type": "application/json"})
                urllib.request.urlopen(req, timeout=POST_TIMEOUT).read()
                self.posts_ok += 1
            except Exception:
                pass

    def latest(self) -> DriveState:
        with self._lock:
            return self._state

    def healthy(self) -> bool:
        return self.latest().fresh

    def _post(self, path: str, payload: dict):
        try:
            self._q.put_nowait((path, payload))
        except queue.Full:
            pass

    def stimulate(self, kind: str, amp: float = 0.5, **extra):

        amp = max(0.0, min(1.0, float(amp)))
        if kind in ("praise", "interrupt", "ignored"):
            self._post("/in", {"v": 1, "intero": {"outcome": kind}, "senses": {}})
            return
        senses = {}
        if kind == "touch":
            senses["touch"] = [["contact", amp]]
        elif kind == "audio":
            senses["audio"] = amp
        elif kind == "vision":
            senses["vision"] = [amp] * 64
        if senses:
            self._post("/in", {"v": 1, "senses": senses, "intero": {}})

    def reward(self, r: float, expr: str | None = None, why: str = ""):

        payload = {"r": max(-1.0, min(1.0, float(r))), "why": why}
        if expr:
            payload["expr"] = str(expr)
        self._post("/reward", payload)

    def speech(self, text: str, salience: float = 0.6):

        t = (text or "").strip()
        if not t:
            return
        self._post("/in", {"v": 1, "senses": {},
                           "speech": {"text": t[:400],
                                      "salience": max(0.0, min(1.0, float(salience)))}})

    def percept(self, text: str, salience: float = 0.6):

        t = (text or "").strip()
        if not t:
            return
        self._post("/in", {"v": 1,
                           "senses": {},
                           "percept": {"kind": "vision", "text": t[:400],
                                       "salience": max(0.0, min(1.0, float(salience)))}})


_client: DriveClient | None = None
_client_lock = threading.Lock()


def get_drive_client() -> DriveClient:
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _client = DriveClient()
                _client.start()
    return _client


def latest_drive_state() -> DriveState:
    return get_drive_client().latest()


def shutdown_drive_client():
    global _client
    with _client_lock:
        if _client is not None:
            _client.stop()
            _client = None
