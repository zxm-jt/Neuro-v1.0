from __future__ import annotations

import json
import math
import os
import threading
import time
from collections import deque
from pathlib import Path

from .paths import STATE

DEFAULT_CAP = int(os.environ.get("NEURO_EPISODE_CAP", "20000"))
LOG_NAME = "episodes.jsonl"

_LOCK = threading.RLock()


class EpisodeLedger:
    def __init__(self, cap: int = DEFAULT_CAP, name: str = LOG_NAME, autoload: bool = True):
        self.cap = int(cap)
        self.path: Path = STATE / name
        self.items: deque[dict] = deque(maxlen=self.cap)
        self.appended = 0
        self.dropped = 0
        self._last_prune = 0.0
        if autoload:
            self.load()

    def record(self, features: dict, axes: dict, actions: dict, reward: float,
               why: str = "", outcome: str = "none", key: str = "",
               novelty: float | None = None) -> dict:
        try:
            r = float(reward)
            if not math.isfinite(r):
                r = 0.0
            r = max(-1.0, min(1.0, r))
            nov = float(novelty) if novelty is not None else abs(r)
            ep = {
                "t": round(time.time(), 3),
                "f": {str(k): _f(v) for k, v in (features or {}).items()},
                "ax": {str(k): _f(v) for k, v in (axes or {}).items()},
                "a": {str(k): _f(v) for k, v in (actions or {}).items()},
                "r": round(r, 4),
                "why": str(why or "")[:64],
                "outcome": str(outcome or "none")[:16],
                "key": str(key or "")[:48],
                "nov": round(max(0.0, min(1.0, nov)), 4),
            }
            with _LOCK:
                self.items.append(ep)
                self.appended += 1
            self._maybe_flush()
            return ep
        except Exception:
            return {}

    def _maybe_flush(self):
        now = time.time()
        with _LOCK:
            if self.appended % 20 != 0 and (now - self._last_prune) < 30.0:
                return
            self._last_prune = now
            batch = list(self.items)[-20:]
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as f:
                for ep in batch:
                    f.write(json.dumps(ep, ensure_ascii=False) + "\n")
        except Exception:
            pass

    def flush(self):
        try:
            with _LOCK:
                batch = list(self.items)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                for ep in batch:
                    f.write(json.dumps(ep, ensure_ascii=False) + "\n")
            tmp.replace(self.path)
        except Exception:
            pass

    def load(self) -> int:
        try:
            if not self.path.exists():
                return 0
            lines = self.path.read_text(encoding="utf-8").splitlines()
        except Exception:
            return 0
        if len(lines) > self.cap:
            lines = lines[-self.cap:]
        with _LOCK:
            self.items.clear()
            for ln in lines:
                ln = ln.strip()
                if not ln:
                    continue
                try:
                    ep = json.loads(ln)
                except Exception:
                    continue
                if isinstance(ep, dict) and "f" in ep:
                    self.items.append(ep)
            self.dropped = max(0, len(lines) - len(self.items))
        return len(self.items)

    def __len__(self):
        return len(self.items)

    def sample(self, n: int = 256, *, prioritized: bool = True,
               min_reward: float | None = None, recent_bias: float = 0.0) -> list[dict]:
        with _LOCK:
            pool = list(self.items)
        if not pool:
            return []
        if min_reward is not None:
            pool = [e for e in pool if abs(float(e.get("r", 0.0))) >= abs(min_reward)]
            if not pool:
                return []
        n = min(int(n), len(pool))
        if n <= 0:
            return []
        if not prioritized:
            step = max(1, len(pool) // n)
            return pool[::step][:n]

        import random
        weights = [0.25 + abs(float(e.get("r", 0.0))) + 0.5 * float(e.get("nov", 0.0))
                   for e in pool]
        weights = [w ** 0.6 for w in weights]
        try:
            picks = random.choices(pool, weights=weights, k=n)
        except Exception:
            return pool[:n]
        if recent_bias > 0:
            tail = pool[-max(1, int(len(pool) * min(0.5, recent_bias))):]
            take = min(len(tail), max(1, int(n * recent_bias)))
            if take and tail:
                picks[:take] = random.choices(tail, k=take)
        return picks

    def holdout(self, n: int = 64, seed: int = 7) -> list[dict]:
        import random
        with _LOCK:
            pool = list(self.items)
        if len(pool) <= n:
            return pool
        rng = random.Random(seed)
        idx = sorted(rng.sample(range(len(pool)), n))
        return [pool[i] for i in idx]

    def stats(self) -> dict:
        with _LOCK:
            pool = list(self.items)
        n = len(pool)
        if not n:
            return {"n": 0, "appended": self.appended, "pos": 0, "neg": 0,
                    "mean_r": 0.0, "keys": 0, "path": str(self.path)}
        rs = [float(e.get("r", 0.0)) for e in pool]
        keys = {e.get("key", "") for e in pool if e.get("key")}
        return {
            "n": n,
            "appended": self.appended,
            "pos": sum(1 for r in rs if r > 0.02),
            "neg": sum(1 for r in rs if r < -0.02),
            "zero": sum(1 for r in rs if abs(r) <= 0.02),
            "mean_r": round(sum(rs) / n, 4),
            "keys": len(keys),
            "path": str(self.path),
        }


def _f(v) -> float:
    try:
        x = float(v)
        return x if math.isfinite(x) else 0.0
    except Exception:
        return 0.0
