from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

from .paths import STATE

DEFAULT_INTERVAL_S = 180.0
DEFAULT_IDLE_S = 25.0
REPLAY_GATE = 0.25
CONSIST_ALPHA = 0.15
SIM_PULL = 0.55
REPLAY_N = 128
REPLAY_STEPS = 600
MIN_EPISODES = 8
MIN_LABELED = 6


class Trainer:
    def __init__(self, core=None, interval_s: float = DEFAULT_INTERVAL_S,
                 idle_s: float = DEFAULT_IDLE_S):
        self.core = core
        self.interval_s = float(interval_s)
        self.idle_s = float(idle_s)
        self.last_run = 0.0
        self.runs = 0
        self.last_stats: dict = {}
        self.log_path = STATE / "learn.jsonl"
        STATE.mkdir(parents=True, exist_ok=True)
        self._best_skill: float | None = None
        self._committed = 0
        self._rolled_back = 0

    def maybe_run(self, core=None) -> dict | None:
        core = core or self.core
        if core is None:
            return None
        now = time.time()
        if now - self.last_run < self.interval_s:
            return None
        last_evt = 0.0
        try:
            if core.percepts:
                last_evt = max(last_evt, float(core.percepts[-1].get("at") or 0))
            last_evt = max(last_evt, float(getattr(core, "_last_reward_at", 0.0) or 0))
            last_evt = max(last_evt, float(getattr(core, "_last_episode_at", 0.0) or 0))
        except Exception:
            pass
        if last_evt and (now - last_evt) < self.idle_s:
            return None
        return self.consolidate(core)

    def consolidate(self, core=None) -> dict:
        core = core or self.core
        now = time.time()
        stats = {"t": round(now, 3), "replayed": 0, "encoder_pulls": 0,
                 "w_norm": 0.0, "vocab": 0, "ok": False}
        try:
            ledger = getattr(core, "episodes", None)
            head = getattr(core, "head", None)
            if ledger is not None and head is not None:
                self._train_head(head, ledger, stats)

            self._consolidate_encoder(core, stats)

            stats["w_norm"] = float(np.abs(core.assoc.W).mean())
            stats["vocab"] = int(getattr(core.encoder.vecs, "shape", [0])[0])
            stats["ok"] = True
            try:
                core.assoc.save()
                core.encoder.save()
            except Exception:
                pass
            self.runs += 1
        except Exception as e:
            stats["error"] = str(e)
        self.last_run = now
        self.last_stats = stats
        try:
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(stats, ensure_ascii=False) + "\n")
        except Exception:
            pass
        return stats

    def _train_head(self, head: dict, ledger, stats: dict):
        from . import learn, ckpt

        if len(ledger) < MIN_EPISODES:
            stats["train"] = {"reason": "too_few_episodes", "n": len(ledger)}
            return

        hpath = _head_path()
        snap = ckpt.commit("heads", hpath, score=self._best_skill, note="pre-train")
        if snap is None:
            stats["train"] = {"reason": "no_head_file"}
            return

        before = learn.evaluate(head, ledger.holdout())
        if before.get("n", 0) < MIN_LABELED:
            stats["train"] = {"reason": "too_few_labeled", "n": before.get("n", 0)}
            return

        batch = ledger.sample(REPLAY_N, prioritized=True)
        import copy
        head_before_train = copy.deepcopy(head)
        fit = learn.fit(head, batch, epochs=1, max_steps=REPLAY_STEPS)
        stats["replayed"] = int(fit.get("steps", 0))

        after = learn.evaluate(head, ledger.holdout())
        b_before = before.get("skill")
        b_after = after.get("skill")
        delta_brier = (after.get("brier") or 1.0) - (before.get("brier") or 1.0)

        if b_before is not None and b_after is not None:
            delta_skill = b_after - b_before
            improved = (delta_skill > 0.0) and (delta_brier < 0.0)
        else:
            delta_skill = None
            improved = delta_brier < -1e-4
        if self._best_skill is None:
            if b_before is not None and b_after is not None:
                improved = (delta_skill >= -0.001) or (after.get("brier", 1.0) <= before.get("brier", 1.0))
            else:
                improved = delta_brier <= 1e-4

        if improved:
            self._best_skill = after.get("skill")
            self._committed += 1
            try:
                from . import heads as _heads
                _heads.save(head)
            except Exception:
                pass
        else:
            try:
                ckpt.rollback("heads", hpath)
                core_head = head
                from . import heads as _heads
                loaded = _heads.load("default")
                for g in ("axes", "actions", "bias", "meta", "features"):
                    if g in loaded:
                        core_head[g] = loaded[g]
                for k in ("updates", "head_version", "updated_at"):
                    if k in loaded:
                        core_head[k] = loaded[k]
                self._rolled_back += 1
            except Exception as e:
                stats["train"] = {"error": f"rollback_failed:{e}"}
                return

        stats["train"] = {
            "before": before, "after": after,
            "delta_skill": (round(delta_skill, 4) if delta_skill is not None else None),
            "delta_brier": round(delta_brier, 5),
            "committed": bool(improved), "steps": int(fit.get("steps", 0)),
            "best_skill": (round(self._best_skill, 4) if self._best_skill is not None else None),
            "rolled_back": self._rolled_back,
        }

    def _consolidate_encoder(self, core, stats: dict):
        per = list(core.percepts)
        if len(per) < 2:
            return
        ax = getattr(core, "_axes", {}) or {}
        acts = getattr(core, "_acts", {}) or {}
        target = core.assoc.target(ax, acts)
        n_kc = int(core.assoc.n_kc)

        for p in per[-6:]:
            text = p.get("text") or ""
            idx = core.encoder.text_to_kc(text)
            if not idx.size:
                continue
            kc = np.zeros(n_kc, dtype=np.float32)
            kc[idx] = 1.0
            core.assoc.write(kc, target, salience=0.35, gate=REPLAY_GATE)
            stats["replayed"] = int(stats.get("replayed", 0)) + 1

        for i in range(len(per)):
            for j in range(i + 1, len(per)):
                a, b = per[i].get("vec"), per[j].get("vec")
                if a is None or b is None:
                    continue
                a = np.asarray(a, dtype=np.float32)
                b = np.asarray(b, dtype=np.float32)
                na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
                if na < 1e-6 or nb < 1e-6:
                    continue
                sim = float(np.dot(a, b) / (na * nb))
                if sim < SIM_PULL:
                    continue
                mean = (a / na + b / nb)
                mean /= (float(np.linalg.norm(mean)) or 1.0)
                per[i]["vec"] = ((1 - CONSIST_ALPHA) * (a / na) + CONSIST_ALPHA * mean)
                per[j]["vec"] = ((1 - CONSIST_ALPHA) * (b / nb) + CONSIST_ALPHA * mean)
                try:
                    enc = core.encoder
                    toks = set(enc.tokens(per[i].get("text") or "") +
                               enc.tokens(per[j].get("text") or ""))
                    for tk in toks:
                        ti = enc.vocab.get(tk)
                        if ti is None:
                            continue
                        enc.vecs[ti] = ((1 - CONSIST_ALPHA) * enc.vecs[ti]
                                        + CONSIST_ALPHA * mean)
                        nn = float(np.linalg.norm(enc.vecs[ti])) or 1.0
                        enc.vecs[ti] /= nn
                except Exception:
                    pass
                stats["encoder_pulls"] += 1

    def status(self) -> dict:
        return {"runs": self.runs, "last": self.last_stats,
                "interval_s": self.interval_s, "idle_s": self.idle_s,
                "committed": self._committed, "rolled_back": self._rolled_back}


def _head_path() -> Path:
    from . import heads as _heads
    return _heads.HEADS / "default.json"
