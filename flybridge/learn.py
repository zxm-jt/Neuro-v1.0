from __future__ import annotations

import math

import numpy as np

AXES = ("valence", "arousal", "tension", "satiety")
ACTIONS = ("speak", "look", "withdraw")

DEFAULTS = {
    "lr": 0.05,
    "lr_half": 400.0,
    "wd": 0.004,
    "w_max": 4.0,
    "baseline_tau": 40.0,
    "label_eps": 0.02,
}


def vec(head: dict, features: dict) -> np.ndarray:
    return np.asarray([float(features.get(f, 0.0) or 0.0) for f in head["features"]],
                      dtype=np.float32)


def _sig(z: float) -> float:
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    e = math.exp(z)
    return e / (1.0 + e)


def _row(head: dict, group: str, name: str) -> np.ndarray:
    return np.asarray([float(head[group][name].get(f, 0.0)) for f in head["features"]],
                      dtype=np.float32)


def _put_row(head: dict, group: str, name: str, w: np.ndarray, w_max: float):
    np.clip(w, -w_max, w_max, out=w)
    d = head[group][name]
    for i, f in enumerate(head["features"]):
        d[f] = float(w[i])


def logits(head: dict, features: dict) -> tuple[np.ndarray, np.ndarray]:
    x = vec(head, features)
    za = np.asarray([float(np.dot(x, _row(head, "axes", n))) + float(head["bias"].get(n, 0.0))
                     for n in AXES], dtype=np.float32)
    zc = np.asarray([float(np.dot(x, _row(head, "actions", n))) + float(head["bias"].get(n, 0.0))
                     for n in ACTIONS], dtype=np.float32)
    return za, zc


def meta(head: dict) -> dict:
    m = head.get("meta")
    if not isinstance(m, dict):
        m = {}
        head["meta"] = m
    for k, v in DEFAULTS.items():
        m.setdefault(k, v)
    m.setdefault("baseline", 0.0)
    m.setdefault("act_mean", {a: 0.5 for a in ACTIONS})
    m.setdefault("ax_mean", {a: 0.0 for a in AXES})
    m.setdefault("samples", 0)
    m.setdefault("good", 0)
    m.setdefault("bad", 0)
    return m


def lr_now(head: dict) -> float:
    m = meta(head)
    return float(m["lr"]) / (1.0 + float(m["samples"]) / max(1.0, float(m["lr_half"])))


def update(head: dict, features: dict, reward: float, *, why: str = "",
           snap_prior: bool = True) -> dict:
    m = meta(head)
    r = float(reward)
    if not math.isfinite(r):
        m["last_update"] = {"skipped": "nan"}
        return head
    r = max(-1.0, min(1.0, r))
    x = vec(head, features)
    if not np.any(x):
        m["last_update"] = {"skipped": "no_features"}
        return head

    if snap_prior and "prior" not in m:
        m["prior"] = {g: {n: dict(head[g][n]) for n in head[g]} for g in ("axes", "actions")}
        m["prior"]["bias"] = dict(head.get("bias", {}))

    lr = lr_now(head)
    wd = float(m["wd"])
    w_max = float(m["w_max"])
    za, zc = logits(head, features)
    axes = np.tanh(za)
    acts = 1.0 / (1.0 + np.exp(-zc))

    has_label = abs(r) >= float(m["label_eps"])
    tau = max(2.0, float(m["baseline_tau"]))
    if has_label:
        m["baseline"] = float(m["baseline"] + (r - float(m["baseline"])) / tau)
    adv = r - float(m["baseline"])

    touched = {"speak": False, "look": False, "withdraw": False, "axes": False}
    xnorm = float(np.dot(x, x)) or 1.0

    if has_label:
        t = 1.0 if r > 0 else 0.0
        err = (float(acts[0]) - t) * abs(r)
        w = _row(head, "actions", "speak") - lr * err * x / math.sqrt(xnorm)
        _put_row(head, "actions", "speak", w, w_max)
        head["bias"]["speak"] = float(np.clip(
            float(head["bias"].get("speak", 0.0)) - lr * err, -3.0, 3.0))
        touched["speak"] = True
        m["good" if r > 0 else "bad"] = int(m.get("good" if r > 0 else "bad", 0)) + 1

    for i, name in enumerate(ACTIONS[1:], start=1):
        ā = float(m["act_mean"].get(name, 0.5))
        a = float(acts[i])
        if abs(adv) >= 1e-6:
            g = adv * (a - ā)
            w = _row(head, "actions", name) - lr * g * x / math.sqrt(xnorm)
            _put_row(head, "actions", name, w, w_max)
            touched[name] = True
        m["act_mean"][name] = float(ā + (a - ā) / tau)

    if has_label:
        for i, name in enumerate(AXES):
            y = float(axes[i])
            b = float(m["ax_mean"].get(name, 0.0))
            if r > 0:
                t = y
            else:
                t = b + 0.5 * (y - b)
            err = (y - t) * abs(r)
            w = _row(head, "axes", name) - lr * err * x / math.sqrt(xnorm)
            _put_row(head, "axes", name, w, w_max)
            touched["axes"] = True
            m["ax_mean"][name] = float(b + (y - b) / tau)

    prior = m.get("prior")
    if prior and wd > 0:
        for g, grp in (("axes", AXES), ("actions", ACTIONS)):
            for n in grp:
                p = prior.get(g, {}).get(n) or {}
                if not p:
                    continue
                w = _row(head, g, n)
                pw = np.asarray([float(p.get(f, 0.0)) for f in head["features"]],
                                dtype=np.float32)
                _put_row(head, g, n, w + wd * (pw - w), w_max)

    m["samples"] = int(m.get("samples", 0)) + 1
    head["updates"] = int(head.get("updates", 0)) + 1
    m["last_update"] = {"r": round(r, 4), "adv": round(float(adv), 4), "lr": round(lr, 5),
                        "baseline": round(float(m["baseline"]), 4),
                        "touched": [k for k, v in touched.items() if v], "why": why[:32]}
    return head


def evaluate(head: dict, eps: list[dict], *, label_eps: float = 0.02) -> dict:
    lab = [e for e in eps if abs(float(e.get("r", 0.0))) >= label_eps]
    n = len(lab)
    if n == 0:
        return {"n": 0, "brier": None, "skill": None, "axis_mse": None,
                "base_rate": None, "mean_speak": None}
    labels = np.asarray([1.0 if float(e["r"]) > 0 else 0.0 for e in lab], dtype=np.float32)
    p = np.zeros(n, dtype=np.float32)
    ax_err = 0.0
    for i, e in enumerate(lab):
        za, zc = logits(head, e.get("f") or {})
        p[i] = 1.0 / (1.0 + np.exp(-float(zc[0])))
        want = np.asarray([float((e.get("ax") or {}).get(k, 0.0)) for k in AXES], dtype=np.float32)
        ax_err += float(np.mean((np.tanh(za) - want) ** 2))
    brier = float(np.mean((p - labels) ** 2))
    base = float(np.mean(labels))
    brier_base = float(np.mean((base - labels) ** 2)) or 1e-9
    return {
        "n": n,
        "brier": round(brier, 5),
        "brier_base": round(brier_base, 5),
        "skill": round(1.0 - brier / brier_base, 4),
        "axis_mse": round(ax_err / n, 5),
        "base_rate": round(base, 4),
        "mean_speak": round(float(np.mean(p)), 4),
    }


def fit(head: dict, eps: list[dict], *, epochs: int = 1, shuffle_seed: int | None = 0,
        max_steps: int = 4000) -> dict:
    if not eps:
        return {"steps": 0}
    import random
    rng = random.Random(shuffle_seed)
    pool = list(eps)
    steps = 0
    for _ in range(max(1, int(epochs))):
        if shuffle_seed is not None:
            rng.shuffle(pool)
        for e in pool:
            if steps >= max_steps:
                break
            update(head, e.get("f") or {}, float(e.get("r", 0.0)), why="replay")
            steps += 1
        if steps >= max_steps:
            break
    return {"steps": steps}
