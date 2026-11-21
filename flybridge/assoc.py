from __future__ import annotations

import json
import time

import numpy as np

from .paths import STATE

AFFECT_DIM = 4
ACTION_DIM = 3
K_ACTIVE = 200


class AssocMemory:
    def __init__(self, kc_idx: np.ndarray, mbon_idx: np.ndarray,
                 eta: float = 0.03, decay_per_s: float = 2e-5, cap: float = 3.0):
        self.kc_idx = np.asarray(kc_idx, dtype=np.int64)
        self.mbon_idx = np.asarray(mbon_idx, dtype=np.int64)
        self.n_kc = int(self.kc_idx.size)
        self.n_mbon = int(self.mbon_idx.size)
        self.W = np.zeros((self.n_kc, AFFECT_DIM + ACTION_DIM), dtype=np.float32)
        self.ema = np.zeros(self.n_kc, dtype=np.float32)
        self.mass = np.zeros(self.n_kc, dtype=np.float32)
        self.eta = float(eta)
        self.decay_per_s = float(decay_per_s)
        self.cap = float(cap)
        self.writes = 0
        self.stats = {"above": 0, "active": 0, "surprise": 0.0}
        self.last_recall = {"strength": 0.0, "affect": [0.0] * AFFECT_DIM,
                            "action": [0.0] * ACTION_DIM}
        self._last_decay = time.time()

    def code(self, fired, hits=None) -> np.ndarray:

        v = np.zeros(self.n_kc, dtype=np.float32)
        if len(fired) == 0:
            self.ema *= 0.995
            return v
        if hits is not None:
            v[hits] = 1.0
            hit = hits
        else:
            hit = np.isin(self.kc_idx, np.asarray(fired), assume_unique=False)
        v[hit] = 1.0
        self.ema *= 0.995
        self.ema += 0.005 * v
        score = v - self.ema
        score[v <= 0] = -1.0
        above = int((score > 0).sum())
        k = min(K_ACTIVE, above)
        if k <= 0:
            self.stats = {"above": 0, "active": 0, "surprise": 0.0}
            return v
        idx = np.argpartition(-score, k - 1)[:k]
        out = np.zeros(self.n_kc, dtype=np.float32)
        out[idx] = 1.0
        pos = score[idx]
        self.stats = {"above": above, "active": int(k),
                      "surprise": float(np.clip(pos.mean(), 0.0, 1.0))}
        return out

    def target(self, axes: dict, acts: dict) -> np.ndarray:
        t = np.zeros(AFFECT_DIM + ACTION_DIM, dtype=np.float32)
        t[0] = axes.get("valence", 0.0)
        t[1] = axes.get("arousal", 0.0)
        t[2] = axes.get("tension", 0.0)
        t[3] = axes.get("satiety", 0.0)
        t[4] = acts.get("speak", 0.5) - 0.5
        t[5] = acts.get("look", 0.5) - 0.5
        t[6] = acts.get("withdraw", 0.5) - 0.5
        return t

    def write(self, kc: np.ndarray, target: np.ndarray, salience: float, gate: float):

        if gate <= 0.0 or kc.sum() == 0:
            return
        lr = self.eta * float(gate) * float(max(0.0, min(2.0, salience)))
        self.W += lr * np.outer(kc, target).astype(np.float32)
        self.mass += (lr * kc).astype(np.float32)
        np.clip(self.W, -self.cap, self.cap, out=self.W)
        self.writes += 1

    def recall(self, kc: np.ndarray) -> dict:

        s = float(kc.sum())
        if s <= 0.0:
            self.last_recall = {"strength": 0.0, "affect": [0.0] * AFFECT_DIM,
                                "action": [0.0] * ACTION_DIM, "confidence": 0.0}
            return self.last_recall
        den = float((self.mass * kc).sum())
        if den <= 1e-9:
            self.last_recall = {"strength": 0.0, "affect": [0.0] * AFFECT_DIM,
                                "action": [0.0] * ACTION_DIM, "confidence": 0.0}
            return self.last_recall
        _m = self.mass[self.mass > 0]
        _m_mean = float(_m.mean()) if _m.size else float(self.eta)
        conf = float(min(1.0, den / max(1e-9, _m_mean * s)))
        pred = (self.W.T @ kc) / den * conf
        aff = pred[:AFFECT_DIM].astype(float).tolist()
        act = pred[AFFECT_DIM:].astype(float).tolist()
        strength = float(np.linalg.norm(pred))
        self.last_recall = {"strength": round(strength, 4), "affect": aff,
                            "action": act, "confidence": round(conf, 4)}
        return self.last_recall

    def decay(self):
        now = time.time()
        dt = now - self._last_decay
        if dt < 1.0:
            return
        self._last_decay = now
        f = float(np.exp(-self.decay_per_s * dt))
        self.W *= f

    def save(self, path: str = "assoc.npz") -> str:
        STATE.mkdir(parents=True, exist_ok=True)
        p = STATE / path
        payload = {"W": self.W, "mass": self.mass, "writes": np.int64(self.writes),
                   "meta": np.frombuffer(json.dumps({"saved_at": time.time(),
                                                     "n_kc": self.n_kc,
                                                     "n_mbon": self.n_mbon}).encode(),
                                         dtype=np.uint8)}
        np.savez_compressed(p, **payload)
        return str(p)

    def load(self, path: str = "assoc.npz") -> bool:
        p = STATE / path
        if not p.exists():
            return False
        try:
            z = np.load(p, allow_pickle=False)
            W = np.asarray(z["W"], dtype=np.float32)
            if W.shape == self.W.shape:
                self.W = W
            self.writes = int(z["writes"]) if "writes" in z else 0
            if "mass" in z:
                m = np.asarray(z["mass"], dtype=np.float32)
                if m.shape != self.mass.shape:
                    raise ValueError("mass shape mismatch")
                self.mass = m
            else:
                self.mass = np.where(np.abs(self.W).sum(axis=1) > 0,
                                     np.float32(self.eta), np.float32(0.0))
                print("[assoc] 迁移：旧档无 mass，已按权重非零重建（回忆置信度会偏保守）")
            return True
        except Exception as e:
            print(f"[assoc] 读档失败: {e}")
            return False
