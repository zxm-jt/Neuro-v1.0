from __future__ import annotations

import hashlib
import json
import re
import time

import numpy as np

from .paths import STATE

DIM = 64
MAX_VOCAB = 8000
K_ACTIVE = 160
LR = 0.05
RNG_SEED = 20261121

_TOK = re.compile(r"[a-z0-9]+|[\u4e00-\u9fff]")


def _hash_unit(tok: str) -> np.ndarray:

    h = hashlib.sha1(tok.encode("utf-8")).digest()
    rng = np.random.default_rng(int.from_bytes(h[:8], "little"))
    v = rng.normal(0.0, 1.0, size=DIM).astype(np.float32)
    n = float(np.linalg.norm(v)) or 1.0
    return (v / n).astype(np.float32)


class PerceptEncoder:
    def __init__(self, n_kc: int, k_active: int = K_ACTIVE, seed: int = RNG_SEED):
        self.n_kc = int(n_kc)
        self.k = int(k_active)
        self.vocab: dict[str, int] = {}
        self.vecs = np.zeros((0, DIM), dtype=np.float32)
        rng = np.random.default_rng(seed)
        R = np.zeros((self.n_kc, DIM), dtype=np.float32)
        for j in range(DIM):
            idx = rng.choice(self.n_kc, size=8, replace=False)
            R[idx, j] = rng.normal(0, 1, size=8).astype(np.float32)
        self.R = R
        self.updates = 0
        self.saved_at = 0.0

    def _tok_id(self, tok: str) -> int:
        i = self.vocab.get(tok)
        if i is not None:
            return i
        if len(self.vocab) >= MAX_VOCAB:
            return -1
        i = len(self.vocab)
        self.vocab[tok] = i
        self.vecs = np.vstack([self.vecs, _hash_unit(tok)[None, :]])
        return i

    def tokens(self, text: str) -> list[str]:
        return _TOK.findall((text or "").lower())[:200]

    def encode(self, text: str) -> np.ndarray:
        toks = self.tokens(text)
        if not toks:
            return np.zeros(DIM, dtype=np.float32)
        acc = np.zeros(DIM, dtype=np.float32)
        n = 0
        for t in toks:
            i = self._tok_id(t)
            if i < 0:
                continue
            acc += self.vecs[i]
            n += 1
        if n:
            acc /= float(n)
        norm = float(np.linalg.norm(acc)) or 1.0
        return (acc / norm).astype(np.float32)

    def to_kc(self, vec: np.ndarray) -> np.ndarray:

        if vec is None or not np.any(vec):
            return np.zeros(0, dtype=np.int64)
        score = self.R @ vec
        k = min(self.k, max(1, int((score != 0).sum())))
        idx = np.argpartition(-np.abs(score), k - 1)[:k]
        return idx.astype(np.int64)

    def text_to_kc(self, text: str, per_tok: int = 8, cap: int = K_ACTIVE) -> np.ndarray:

        seen: dict[int, None] = {}
        for t in self.tokens(text):
            h = hashlib.sha1(t.encode("utf-8")).digest()
            rng = np.random.default_rng(int.from_bytes(h[:8], "little"))
            for i in rng.choice(self.n_kc, size=per_tok, replace=False).tolist():
                seen[i] = None
                if len(seen) >= cap:
                    break
            if len(seen) >= cap:
                break
        return np.fromiter(seen.keys(), dtype=np.int64, count=len(seen))

    def learn(self, text: str, target_affect: np.ndarray, reward: float):

        if not text or reward == 0:
            return 0
        tgt = np.asarray(target_affect, dtype=np.float32).reshape(-1)
        if tgt.size != DIM:
            tgt = np.resize(tgt, DIM)
        norm = float(np.linalg.norm(tgt)) or 1.0
        tgt = tgt / norm
        n = 0
        for t in self.tokens(text):
            i = self._tok_id(t)
            if i < 0:
                continue
            self.vecs[i] += np.float32(LR * float(reward)) * (tgt - self.vecs[i])
            self.vecs[i] /= (float(np.linalg.norm(self.vecs[i])) or 1.0)
            n += 1
        self.updates += 1
        return n

    def save(self, path: str = "encoder.npz") -> str:
        STATE.mkdir(parents=True, exist_ok=True)
        p = STATE / path
        meta = json.dumps({"dim": DIM, "k": self.k, "n_kc": self.n_kc,
                           "updates": self.updates, "saved_at": time.time()})
        np.savez_compressed(
            p,
            vecs=self.vecs,
            R=self.R,
            vocab=np.frombuffer(json.dumps(self.vocab).encode("utf-8"), dtype=np.uint8),
            meta=np.frombuffer(meta.encode("utf-8"), dtype=np.uint8),
        )
        self.saved_at = time.time()
        return str(p)

    def load(self, path: str = "encoder.npz") -> bool:
        p = STATE / path
        if not p.exists():
            return False
        try:
            z = np.load(p, allow_pickle=False)
            vecs = np.asarray(z["vecs"], dtype=np.float32)
            if vecs.ndim == 2 and vecs.shape[1] == DIM and vecs.shape[0] > 0:
                self.vecs = vecs
                self.vocab = json.loads(bytes(z["vocab"]).decode("utf-8"))
                if len(self.vocab) != self.vecs.shape[0]:
                    raise ValueError("vocab/vec mismatch")
            if "R" in z:
                R = np.asarray(z["R"], dtype=np.float32)
                if R.shape == (self.n_kc, DIM):
                    self.R = R
            try:
                meta = json.loads(bytes(z["meta"]).decode("utf-8"))
                self.updates = int(meta.get("updates", 0))
            except Exception:
                pass
            return True
        except Exception as e:
            print(f"[encoder] 读档失败（重建）: {e}")
            return False
