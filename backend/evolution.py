# -*- coding: utf-8 -*-
from __future__ import annotations

import math
import random
import time

_FALLBACK = {
    "enabled": True,
    "population": 8,
    "elites": 2,
    "generations": 3,
    "mutation_sigma": 0.12,
    "patience": 2,
}

_KNOBS = ("warmth", "brevity", "initiative")


def _cfg() -> dict:
    out = dict(_FALLBACK)
    try:
        import json as _j
        from pathlib import Path as _P
        c = _j.loads((_P(__file__).resolve().parent.parent / "config.json").read_text(encoding="utf-8"))
        m = c.get("mind") or {}
        u = ((m.get("ecology") or {}).get("evolution") or m.get("evolution") or {})
        if isinstance(u.get("enabled"), bool):
            out["enabled"] = u["enabled"]
        for k in _FALLBACK:
            if isinstance(u.get(k), (int, float)) and not isinstance(u.get(k), bool):
                out[k] = float(u[k]) if k not in ("population", "elites", "generations", "patience") else int(u[k])
    except Exception:
        pass
    return out


def _default_fitness(candidate: dict, context: dict) -> float:

    try:
        import arbiter as _a
        action = candidate.get("action", "wait")
        kind = context.get("kind", "idle")
        r = _a.utility_scores(kind, addressing=bool(context.get("addressing")),
                              text=str(context.get("text", "")))
        U = r.get("U", {})
        base = float(U.get(action if action in U else "wait", 0.0))
        return base
    except Exception:
        return 0.0


def evolve(context: dict, *, baseline: str = "speak",
           fitness_fn=None, seed: int | None = None) -> dict:

    cfg = _cfg()
    out = {"action": baseline, "params": {k: 0.5 for k in _KNOBS},
           "score": 0.0, "generations": 0, "reason": "baseline"}
    try:
        if not cfg["enabled"]:
            out["reason"] = "disabled"
            return out
        fit = fitness_fn or _default_fitness
        rng = random.Random(seed if seed is not None else int(time.time() * 1000) % 10**9)
        sigma = max(0.01, float(cfg["mutation_sigma"]))
        pop_n = max(2, int(cfg["population"]))
        elites = max(1, min(int(cfg["elites"]), pop_n))
        max_gen = max(1, int(cfg["generations"]))
        patience = max(1, int(cfg["patience"]))

        actions = ["speak", "ack", "wait"]
        def rand_params():
            return {k: min(1.0, max(0.0, rng.gauss(0.5, sigma))) for k in _KNOBS}

        population = []
        for i in range(pop_n):
            action = baseline if i < elites else rng.choice(actions)
            population.append({"action": action, "params": rand_params()})

        best = None
        best_score = -1e9
        stall = 0
        for gen in range(1, max_gen + 1):
            scored = []
            for cand in population:
                try:
                    s = float(fit(cand, context))
                except Exception:
                    s = 0.0
                scored.append((s, cand))
            scored.sort(key=lambda x: -x[0])
            gen_best, gen_cand = scored[0]
            if gen_best > best_score + 1e-4:
                best_score, best, stall = gen_best, gen_cand, 0
            else:
                stall += 1
            if stall >= patience:
                out["generations"] = gen
                break
            nxt = [dict(c) for _, c in scored[:elites]]
            while len(nxt) < pop_n:
                parent = dict(rng.choice(scored[: max(1, pop_n // 2)])[1])
                parent["params"] = {
                    k: min(1.0, max(0.0, v + rng.gauss(0, sigma)))
                    for k, v in parent["params"].items()
                }
                if rng.random() < 0.15:
                    parent["action"] = rng.choice(actions)
                nxt.append(parent)
            population = nxt
            out["generations"] = gen

        if best is not None:
            out["action"] = best["action"]
            out["params"] = {k: round(v, 3) for k, v in best["params"].items()}
            out["score"] = round(best_score, 4)
            out["reason"] = "evolved"
        return out
    except Exception as e:
        out["reason"] = f"error:{type(e).__name__}"
        return out


def decide_action(U: dict, *, context: dict | None = None,
                  intent_consistency=None, bonus: float = 0.10) -> dict:

    context = context or {}
    actions = [a for a in ("speak", "ack", "wait") if a in U]
    if not actions:
        return {"action": "wait", "score": 0.0, "utility": 0.0,
                "intent_bias": 0.0, "chosen_by": "fallback", "reason": "no_candidates"}
    if intent_consistency is None:
        try:
            import intent as _it
            intent_consistency = _it.consistency
        except Exception:
            intent_consistency = lambda action: 0.0

    def score_of(a: str) -> tuple[float, float]:
        util = float(U.get(a, 0.0))
        try:
            bias = float(intent_consistency(a)) if intent_consistency else 0.0
        except Exception:
            bias = 0.0
        return util + max(-0.5, min(1.0, bias)) * float(bonus), bias

    try:
        cfg = _cfg()
        if not cfg["enabled"]:
            a = max(actions, key=lambda x: U.get(x, 0.0))
            return {"action": a, "score": float(U[a]), "utility": float(U[a]),
                    "intent_bias": 0.0, "chosen_by": "utility",
                    "reason": "evolution_disabled"}
        best_a = max(actions, key=lambda a: score_of(a)[0])
        best_total, best_bias = score_of(best_a)
        util = float(U[best_a])
        return {"action": best_a, "score": round(best_total, 4),
                "utility": round(util, 4), "intent_bias": round(best_bias, 4),
                "chosen_by": "evolution+intent" if abs(best_bias) > 1e-6 else "evolution",
                "reason": f"U={util:.3f}+intent={best_bias:.3f}×{bonus:.2f}"}
    except Exception as e:
        a = max(actions, key=lambda x: U.get(x, 0.0))
        return {"action": a, "score": float(U[a]), "utility": float(U[a]),
                "intent_bias": 0.0, "chosen_by": "fallback",
                "reason": f"error:{type(e).__name__}"}


def refine_action(context: dict, *, proposed: str,
                  fitness_fn=None, seed: int | None = None) -> str:

    try:
        r = evolve(context, baseline=proposed, fitness_fn=fitness_fn, seed=seed)
        return r["action"] if r.get("reason") in ("evolved", "baseline") else proposed
    except Exception:
        return proposed


def stats() -> dict:
    cfg = _cfg()
    return {"enabled": cfg["enabled"], "population": cfg["population"],
            "generations": cfg["generations"], "knobs": list(_KNOBS)}


if __name__ == "__main__":
    def fit(cand, ctx):
        return 0.3 + 0.5 * cand["params"]["warmth"] + (0.1 if cand["action"] == "speak" else 0)
    r = evolve({"kind": "idle"}, fitness_fn=fit, seed=42)
    print("搜索结果:", r)
    assert r["reason"] == "evolved" and r["action"] == "speak"
    assert r["params"]["warmth"] > 0.5, "应找到高 warmth 候选"
    print("EVOLUTION OK")
