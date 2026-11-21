from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

from .paths import STATE

HEADS = STATE / "heads"

AXES = ("valence", "arousal", "tension", "satiety")
ACTIONS = ("speak", "look", "withdraw")
FEATURES = ("spont", "escape", "forward", "steer", "hr_affect", "hr_emotion",
            "intero_replied", "novelty", "vis", "orn", "kc", "mbon", "drive",
            "recall_val", "recall_aro", "recall_conf")

PRIOR = {
    "axes": {
        "valence": {"forward": 0.35, "escape": -0.45, "intero_replied": 0.9, "novelty": 0.25,
                    "recall_val": 0.55},
        "arousal": {"spont": 0.25, "escape": 0.6, "steer": 0.2, "novelty": 0.45,
                    "recall_aro": 0.35,
                    "vis": 0.35, "kc": 1.2, "drive": 0.8},
        "tension": {"escape": 0.5, "spont": 0.15, "mbon": 0.4, "vis": 0.2, "kc": 0.6,
                    "drive": 0.3},
        "satiety": {"forward": 0.3, "intero_replied": 0.5, "orn": 0.4},
    },
    "actions": {
        "speak": {"hr_affect": 0.5, "hr_emotion": 0.35, "spont": 0.2, "novelty": 0.45,
                  "recall_conf": 0.30},
        "look": {"hr_affect": 0.3, "spont": 0.35, "escape": 0.2, "vis": 0.3},
        "withdraw": {"escape": 0.7, "tension": 0.2, "mbon": 0.2},
    },
    "bias": {"valence": 0.0, "arousal": 0.0, "tension": 0.0, "satiety": 0.0,
             "speak": -0.2, "look": 0.0, "withdraw": 0.0},
}


def _zeros(names, feats):
    return {n: {f: 0.0 for f in feats} for n in names}


def default_head() -> dict:
    axes = _zeros(AXES, FEATURES)
    acts = _zeros(ACTIONS, FEATURES)
    for n, d in PRIOR["axes"].items():
        axes[n].update(d)
    for n, d in PRIOR["actions"].items():
        acts[n].update(d)
    return {"head_version": 1, "features": list(FEATURES), "axes": axes,
            "actions": acts, "bias": dict(PRIOR["bias"]),
            "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"), "updates": 0}


def load(name: str = "default") -> dict:
    p = HEADS / f"{name}.json"
    if not p.exists():
        h = default_head()
        save(h, name)
        return h
    h = json.loads(p.read_text(encoding="utf-8"))
    changed = False
    for group in ("axes", "actions"):
        for n in h.get(group, {}):
            for f in FEATURES:
                if f not in h[group][n]:
                    h[group][n][f] = 0.0
                    changed = True
    if h.get("features") != list(FEATURES):
        h["features"] = list(FEATURES)
        changed = True
    if changed:
        save(h, name)
    return h


def save(head: dict, name: str = "default") -> None:
    HEADS.mkdir(parents=True, exist_ok=True)
    head["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    (HEADS / f"{name}.json").write_text(json.dumps(head, ensure_ascii=False, indent=1), encoding="utf-8")


def _vec(features: dict, feats) -> np.ndarray:
    return np.asarray([float(features.get(f, 0.0)) for f in feats], dtype=np.float32)


def forward(head: dict, features: dict) -> tuple[dict, dict]:
    feats = head["features"]
    x = _vec(features, feats)
    axes = {n: float(np.dot(x, _vec(head["axes"][n], feats)) + head["bias"].get(n, 0.0)) for n in AXES}
    acts = {n: float(np.dot(x, _vec(head["actions"][n], feats)) + head["bias"].get(n, 0.0)) for n in ACTIONS}
    axes = {k: float(np.tanh(v)) for k, v in axes.items()}
    acts = {k: float(1.0 / (1.0 + np.exp(-v))) for k, v in acts.items()}
    return axes, acts


def update(head: dict, features: dict, reward: float, lr: float = 0.02, *, why: str = "") -> dict:
    from . import learn as _learn
    return _learn.update(head, features, reward, why=why)


def value(head: dict, features: dict) -> float:
    _, acts = forward(head, features)
    return float(acts.get("speak", 0.0))
