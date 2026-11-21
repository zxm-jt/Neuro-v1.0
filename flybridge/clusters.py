from __future__ import annotations

import json
import time

import numpy as np

from .paths import STATE

MAX_CLUSTERS = 48
NEW_CLUSTER_DIST = 0.45
MOVE_RATE = 0.02
MAX_EXPR = 64


class AffectClusters:
    def __init__(self):
        self.centroids: list[list[float]] = []
        self.counts: list[int] = []
        self.expr: list[dict] = []
        self.last_id = -1
        self.last_dist = 1e9
        self.updates = 0

    def observe(self, axes: dict) -> dict:

        x = np.asarray([axes.get(k, 0.0) for k in ("valence", "arousal", "tension", "satiety")],
                       dtype=np.float32)
        self.updates += 1
        was_new = False
        i = 0
        dist = 0.0
        if not self.centroids:
            self._add(x)
            was_new = True
            i = len(self.centroids) - 1
        else:
            C = np.asarray(self.centroids, dtype=np.float32)
            d = np.linalg.norm(C - x[None, :], axis=1)
            i = int(np.argmin(d))
            if d[i] > NEW_CLUSTER_DIST and len(self.centroids) < MAX_CLUSTERS:
                self._add(x)
                was_new = True
                i = len(self.centroids) - 1
                dist = 0.0
            else:
                c = np.asarray(self.centroids[i], dtype=np.float32)
                c = c + MOVE_RATE * (x - c)
                self.centroids[i] = c.astype(float).tolist()
                self.counts[i] += 1
                dist = float(d[i])
        self.last_id = i
        self.last_dist = dist
        conf = float(max(0.0, 1.0 - dist / 1.5))
        return {"cluster": i, "distance": round(dist, 3), "confidence": round(conf, 3),
                "was_new": was_new, "n_clusters": len(self.centroids)}

    def _add(self, x):
        self.centroids.append(np.asarray(x, dtype=float).tolist())
        self.counts.append(1)
        self.expr.append({})

    def expression(self) -> str | None:
        if self.last_id < 0 or self.last_id >= len(self.expr):
            return None
        w = self.expr[self.last_id]
        if not w:
            return None
        return max(w.items(), key=lambda kv: kv[1])[0]

    def reinforce(self, expression: str | None, reward: float):

        if not expression or self.last_id < 0 or self.last_id >= len(self.expr):
            return
        d = self.expr[self.last_id]
        d[expression] = float(d.get(expression, 0.0) + max(-1.0, min(1.0, reward)))
        if len(d) > MAX_EXPR:
            keep = sorted(d.items(), key=lambda kv: -abs(kv[1]))[:MAX_EXPR]
            self.expr[self.last_id] = dict(keep)

    def save(self, path: str = "clusters.json") -> str:
        STATE.mkdir(parents=True, exist_ok=True)
        p = STATE / path
        p.write_text(json.dumps({"saved_at": time.time(), "centroids": self.centroids,
                                 "counts": self.counts, "expr": self.expr,
                                 "updates": self.updates}, ensure_ascii=False),
                     encoding="utf-8")
        return str(p)

    def load(self, path: str = "clusters.json") -> bool:
        p = STATE / path
        if not p.exists():
            return False
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            self.centroids = [list(map(float, c)) for c in d.get("centroids", [])]
            self.counts = [int(c) for c in d.get("counts", [])]
            self.expr = [dict(e) for e in d.get("expr", [])]
            self.updates = int(d.get("updates", 0))
            return bool(self.centroids)
        except Exception as e:
            print(f"[clusters] 读档失败: {e}")
            return False
