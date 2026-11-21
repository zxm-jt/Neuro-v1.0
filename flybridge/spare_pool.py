from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

if os.environ.get("NEURO_FLY_DATA"):
    os.environ["FLY_DATA"] = os.environ["NEURO_FLY_DATA"]

import numpy as np

HERE = Path(__file__).resolve().parent
PORTS = HERE / "ports"

DEFAULT_POOLS = {
    "affect_integrator": {"superclass": ["cb_intrinsic"], "pick": "low_rate", "n": 1200},
    "speak_drive":       {"superclass": ["cb_intrinsic"], "pick": "random",   "n": 400},
    "emotion_valence":   {"superclass": ["cb_intrinsic"], "pick": "low_rate", "n": 600},
    "emotion_arousal":   {"superclass": ["vnc_intrinsic"], "pick": "low_rate", "n": 600},
    "intero_buffer":     {"superclass": ["ol_intrinsic"], "pick": "low_rate", "n": 2000},
}


def _brain():
    from flybrain import FlyBrain
    return FlyBrain(device="cpu", sensory_input=False, seed=64)


def build(measure_frames: int = 100, seed: int = 64) -> dict:
    b = _brain()
    sc = np.asarray(b.superclass).astype(str)
    seen = np.zeros(b.n, dtype=bool)
    for _ in range(measure_frames):
        seen[b.step()] = True
    rate = seen.astype(np.float32)

    rng = np.random.default_rng(seed)
    pools = {}
    for name, spec in DEFAULT_POOLS.items():
        mask = np.zeros(b.n, dtype=bool)
        for s in spec["superclass"]:
            mask |= sc == s
        cand = np.flatnonzero(mask)
        if cand.size == 0:
            pools[name] = []
            continue
        if spec["pick"] == "low_rate":
            order = np.argsort(rate[cand], kind="stable")
            cand = cand[order]
        else:
            rng.shuffle(cand)
        pools[name] = cand[: int(spec["n"])].tolist()

    manifest = {
        "manifest_version": 1,
        "build": "male-cns:v1.0",
        "seed": seed,
        "measured_frames": measure_frames,
        "idle_fraction": float(1.0 - rate.mean()),
        "pools": {k: [int(x) for x in v] for k, v in pools.items()},
        "spec": DEFAULT_POOLS,
    }
    PORTS.mkdir(parents=True, exist_ok=True)
    out = PORTS / "spare_pool.json"
    out.write_text(json.dumps(manifest), encoding="utf-8")
    print(f"[spare_pool] wrote {out}  pools="
          f"{ {k: len(v) for k, v in manifest['pools'].items()} }  idle={manifest['idle_fraction']:.1%}")
    return manifest


def load() -> dict:
    p = PORTS / "spare_pool.json"
    if not p.exists():
        return build()
    return json.loads(p.read_text(encoding="utf-8"))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", type=int, default=100)
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args(argv)
    if a.check:
        m = load()
        print(json.dumps({k: len(v) for k, v in m["pools"].items()}, ensure_ascii=False))
        return 0
    build(a.frames)
    return 0


if __name__ == "__main__":
    sys.exit(main())
