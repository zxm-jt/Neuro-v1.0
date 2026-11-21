from __future__ import annotations

import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
_DEFAULT = HERE / "state"


def state_dir() -> Path:
    raw = (os.environ.get("NEURO_STATE_DIR") or "").strip()
    if raw:
        try:
            p = Path(raw).expanduser().resolve()
            p.mkdir(parents=True, exist_ok=True)
            return p
        except Exception:
            pass
    try:
        _DEFAULT.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    return _DEFAULT


def is_isolated() -> bool:
    return bool((os.environ.get("NEURO_STATE_DIR") or "").strip())


STATE = state_dir()


def path(*parts: str) -> Path:
    p = STATE.joinpath(*parts)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    return p
