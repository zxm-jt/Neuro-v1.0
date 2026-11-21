from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

from .paths import STATE

_KEEP = 6


def _dir(name: str) -> Path:
    d = STATE / "ckpt" / name
    try:
        d.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    return d


def commit(name: str, src: Path, score: float | None = None, note: str = "") -> str | None:
    try:
        if not src.exists():
            return None
        d = _dir(name)
        ts = time.strftime("%Y%m%d-%H%M%S")
        seq = 0
        while True:
            cand = d / f"{ts}-{seq:02d}.snap"
            if not cand.exists():
                break
            seq += 1
        dst = cand
        shutil.copy2(src, dst)
        meta = {"t": time.time(), "score": (round(score, 6) if score is not None else None),
                "note": note[:200], "src": str(src)}
        (dst.with_suffix(".meta.json")).write_text(json.dumps(meta, ensure_ascii=False),
                                                   encoding="utf-8")
        _prune(d, keep=_KEEP)
        return str(dst)
    except Exception:
        return None


def _prune(d: Path, keep: int):
    snaps = sorted(d.glob("*.snap"), key=lambda p: p.stat().st_mtime, reverse=True)
    for p in snaps[keep:]:
        try:
            p.unlink()
            meta = p.with_suffix(".meta.json")
            if meta.exists():
                meta.unlink()
        except Exception:
            pass


def rollback(name: str, src: Path) -> bool:
    try:
        d = _dir(name)
        snaps_before = sorted(d.glob("*.snap"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not snaps_before:
            return False
        target = snaps_before[0]
        commit(name, src, score=None, note="pre-rollback")
        shutil.copyfile(target, src)
        return True
    except Exception:
        return False


def list_ckpt(name: str) -> list[dict]:
    d = _dir(name)
    out = []
    for p in sorted(d.glob("*.snap"), key=lambda p: p.stat().st_mtime, reverse=True):
        meta = {}
        mp = p.with_suffix(".meta.json")
        if mp.exists():
            try:
                meta = json.loads(mp.read_text(encoding="utf-8"))
            except Exception:
                meta = {}
        out.append({"file": p.name, "t": meta.get("t"), "score": meta.get("score"),
                    "note": meta.get("note", "")})
    return out
