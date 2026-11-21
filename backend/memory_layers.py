# -*- coding: utf-8 -*-
from __future__ import annotations

import datetime
import json
import os
import re
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MEM_DIR = ROOT / "memory"
PROCEDURAL_FILE = "procedural.json"

_LOCK = threading.RLock()

LAYERS = ("working", "episodic", "semantic", "procedural")
SOURCES = ("user", "vision", "self", "tool", "system")

_SOURCE_CONF = {"user": 0.70, "vision": 0.50, "self": 0.45, "tool": 0.55, "system": 0.60}

_SEMANTIC_RE = re.compile(
    r"(?:喜欢|不喜欢|讨厌|偏好|习惯|是|叫|名字|生日|来自|住|工作|职业|is|are|like|love|"
    r"hate|prefer|name|born|live|work|always|never|usually)", re.I)
_PROCEDURAL_RE = re.compile(
    r"(?:如何|怎么|步骤|方法|规则|流程|记得要|每次.{0,8}都|先.{0,12}再|每当|只要.{0,8}就|"
    r"how to|steps|rule|procedure|always.*when|whenever)", re.I)


def _now() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def classify_layer(text: str, tags: list | None = None, source: str = "user") -> str:

    t = (text or "")
    tg = " ".join(str(x) for x in (tags or []))
    if _PROCEDURAL_RE.search(t) or "proc:" in tg or "habit:" in tg:
        return "procedural"
    if _SEMANTIC_RE.search(t) or "fact:" in tg or "preference:" in tg:
        return "semantic"
    return "episodic"


def decorate_fragment(frag: dict) -> dict:

    if not isinstance(frag, dict):
        return frag
    text = str(frag.get("text") or "")
    tags = frag.get("tags") or []
    if not frag.get("layer"):
        frag["layer"] = classify_layer(text, tags)
    if not frag.get("source"):
        frag["source"] = "vision" if any(str(x).startswith("vision") for x in tags) else "user"
    if frag.get("confidence") is None:
        s = frag["source"] if frag["source"] in _SOURCE_CONF else "user"
        base = _SOURCE_CONF[s]
        hits = int(frag.get("hits", 0) or 0)
        frag["confidence"] = round(min(0.98, base + 0.02 * hits), 3)
    if not frag.get("created_at"):
        frag["created_at"] = frag.get("ts") or _now()
    return frag


def load_layered_fragments() -> list[dict]:

    try:
        import memory_system as ms
        frags = ms.load_memories()
    except Exception:
        frags = []
    return [decorate_fragment(f) for f in frags]


def by_layer(layer: str) -> list[dict]:
    if layer not in LAYERS:
        return []
    if layer == "working":
        try:
            import cognition as cg
            s = cg.snapshot()
            return [{"kind": k, "value": v, "layer": "working", "source": "system",
                     "confidence": 1.0, "created_at": _now()}
                    for k, v in s.items() if k in ("turn_state", "task_goal",
                                                   "pending_observations", "drives")]
        except Exception:
            return []
    if layer == "procedural":
        return list_procedural()
    return [f for f in load_layered_fragments() if f.get("layer") == layer]


def reinforce(text: str, delta: float = 0.05) -> bool:

    try:
        import memory_system as ms
        frags = ms.load_memories()
        changed = False
        for f in frags:
            if (f.get("text") or "").strip() == (text or "").strip():
                f = decorate_fragment(f)
                f["confidence"] = round(min(0.99, float(f["confidence"]) + delta), 3)
                f["hits"] = int(f.get("hits", 0)) + 1
                changed = True
        if changed:
            ms._save_memories(frags)
        return changed
    except Exception:
        return False


def _proc_path() -> Path:
    return MEM_DIR / PROCEDURAL_FILE


def _load_proc() -> dict:
    try:
        with open(_proc_path(), "r", encoding="utf-8") as f:
            d = json.load(f)
        if not isinstance(d, dict):
            return {"items": []}
        d.setdefault("items", [])
        return d
    except Exception:
        return {"items": []}


def _save_proc(d: dict) -> bool:
    try:
        MEM_DIR.mkdir(parents=True, exist_ok=True)
        with open(_proc_path(), "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
        return True
    except Exception:
        return False


def list_procedural() -> list[dict]:
    return [dict(x) for x in _load_proc().get("items", []) if isinstance(x, dict)]


def add_procedural(rule: str, *, trigger: str = "", action: str = "",
                   confidence: float = 0.6, source: str = "self") -> bool:

    rule = (rule or "").strip()
    if not rule:
        return False
    with _LOCK:
        d = _load_proc()
        for it in d["items"]:
            if (it.get("rule") or "").strip() == rule:
                it["confidence"] = round(min(0.99, float(it.get("confidence", 0.5)) + 0.05), 3)
                it["hits"] = int(it.get("hits", 0)) + 1
                it["updated_at"] = _now()
                return _save_proc(d)
        d["items"].append({
            "rule": rule, "trigger": trigger, "action": action,
            "layer": "procedural", "source": source if source in SOURCES else "self",
            "confidence": round(min(1.0, max(0.0, float(confidence))), 3),
            "hits": 0, "created_at": _now(), "updated_at": _now(),
        })
        return _save_proc(d)


def decay_procedural(factor: float = 0.98):

    with _LOCK:
        d = _load_proc()
        for it in d["items"]:
            it["confidence"] = round(max(0.1, float(it.get("confidence", 0.5)) * factor), 3)
        return _save_proc(d)


def layer_stats() -> dict:
    out = {k: 0 for k in LAYERS}
    for f in load_layered_fragments():
        out[f.get("layer", "episodic")] = out.get(f.get("layer", "episodic"), 0) + 1
    out["procedural"] = len(list_procedural())
    return out
