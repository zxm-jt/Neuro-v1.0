from __future__ import annotations

import os
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
os.environ.setdefault("FLY_DATA", os.environ.get("NEURO_FLY_DATA") or str(HERE / "data"))

MOTOR_ACTIONS = ("forward", "steer", "escape", "backward", "punch", "kick")
SIDES = ("L", "R")


def _load_brain(data_dir: str | None = None, seed: int = 64):
    from flybrain import FlyBrain
    return FlyBrain(device="cpu", sensory_input=False, seed=seed, data=data_dir or (HERE / "data"))


def _shuffle_weights(brain, rng):

    indices = brain.indices.copy()
    weights = brain.weights.copy()
    rng.shuffle(indices)

    b2 = _load_brain(seed=64)
    b2.indices = indices
    b2.weights = weights
    return b2


def _motor_activity(brain, fired):

    if fired is None or len(fired) == 0:
        return 0
    fired_set = set(int(i) for i in fired)
    hits = 0
    for action in MOTOR_ACTIONS:
        for side in SIDES:
            g = f"{action}_{side}"
            idx = brain.groups.get(g)
            if idx is None:
                continue
            idx_arr = np.asarray(idx, dtype=np.int64).reshape(-1)
            if np.any(np.isin(idx_arr, np.fromiter(fired_set, dtype=np.int64))):
                hits += 1
    return hits


def _run_frames(brain, frames=40, drive=0.8):

    n_visual = len(brain.visual)
    eye = np.full(n_visual, float(drive), dtype=np.float32)

    total_spikes = 0
    motor_hits = 0
    active = set()
    for _ in range(frames):
        fired = brain.step(eye_drive=eye)
        total_spikes += len(fired)
        motor_hits += _motor_activity(brain, fired)
        active.update(int(i) for i in fired)
    return total_spikes, motor_hits, len(active)


def main() -> int:
    print("[1] 加载真实连接组")
    b_real = _load_brain()
    print(f"  neurons={b_real.n}, connections={len(b_real.weights)}, photoreceptors={len(b_real.visual)}")

    rng = np.random.default_rng(20261121)

    print("[2] 跑真实连接组（注入视觉 40 帧）")
    r_total, r_motor, r_active = _run_frames(b_real, frames=40)
    print(f"  总放电={r_total}, 运动组命中={r_motor}, 活跃神经元={r_active}")

    print("[3] 打乱权重（保持权重/符号分布，只丢拓扑）并跑同样输入")
    b_shuf = _shuffle_weights(b_real, rng)
    s_total, s_motor, s_active = _run_frames(b_shuf, frames=40)
    print(f"  总放电={s_total}, 运动组命中={s_motor}, 活跃神经元={s_active}")

    print()
    print("[4] 判定：结构是否显著影响动态")
    total_diff = abs(r_total - s_total) / max(r_total, 1)
    motor_diff = abs(r_motor - s_motor) / max(r_motor, s_motor, 1)

    structure_matters = (motor_diff > 0.20) or (total_diff > 0.15)
    print(f"  总放电相对差异 = {total_diff:.2%}")
    print(f"  运动组命中相对差异 = {motor_diff:.2%}")

    if structure_matters:
        print()
        print("PASS：真实连接组的活动模式与打乱网络显著不同 —— 结构携带了计算能力。")
        print("   （这与 Shiu et al. 2024 的结论一致：不是随机网络，是真实布线在起作用。）")
        return 0
    else:
        print()
        print("WARN：真实与打乱网络活动差异不大（可能当前注入/读出对结构不敏感，")
        print("   或样本帧数太少。不代表脑无效，但值得排查注入通路是否真正触达连接组。）")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
