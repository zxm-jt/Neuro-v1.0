# -*- coding: utf-8 -*-
from __future__ import annotations

import datetime
import json
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MEM_DIR = ROOT / "memory"
TOMORROW = MEM_DIR / "tomorrow.json"
CONSOLIDATE_LOG = MEM_DIR / "consolidation.jsonl"

_LOCK = threading.RLock()
_MIN_FRAGS_FOR_HABIT = 3


def _now() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _date() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d")


def compress_memory() -> dict:

    out = {"ok": False}
    try:
        import memory_system as ms
        kept, removed = ms.forget()
        wk = ms.maybe_weekly_maintenance()
        wk_removed = wk[1] if wk else 0
        out = {"ok": True, "kept": kept, "removed": removed + wk_removed}
    except Exception as e:
        out["error"] = str(e)
    return out


def _top_tags(n: int = 3) -> list[str]:
    try:
        import memory_system as ms
        from collections import Counter
        cnt = Counter()
        for f in ms.load_memories():
            for t in (f.get("tags") or []):
                s = str(t)
                if s.startswith("theme:") and len(s) > len("theme:"):
                    cnt[s] += 1
        return [k for k, _ in cnt.most_common(n)]
    except Exception:
        return []


def form_habits() -> dict:

    formed = []
    try:
        import memory_layers as ml
        import reflection as rf
        try:
            ins = json.loads(INSIGHTS.read_text(encoding="utf-8")) if INSIGHTS.exists() else {}
            for sg in ins.get("suggestions", []):
                if sg.get("target") == "mind.utility.quiet_hours_note" and sg.get("suggest"):
                    hrs = ",".join(str(h) for h in sg["suggest"])
                    rule = f"用户在这些时段更容易接受主动交流：{hrs}点"
                    if ml.add_procedural(rule, trigger="选择主动开口时机", action="优先这些时段",
                                         confidence=0.65, source="self"):
                        formed.append(rule)
        except Exception:
            pass
        for tag in _top_tags(2):
            topic = tag.split(":", 1)[-1]
            if not topic or topic == "misc":
                continue
            rule = f"用户经常聊到：{topic}"
            if ml.add_procedural(rule, trigger=f"话题涉及{topic}", action="可自然提起",
                                 confidence=0.6, source="self"):
                formed.append(rule)
        ml.decay_procedural(factor=0.99)
    except Exception:
        pass
    return {"formed": formed}


INSIGHTS = MEM_DIR / "reflection_insights.json"


def _unfinished_goals() -> list[str]:
    try:
        import cognition as cg
        s = cg.snapshot()
        out = []
        if s.get("task_goal"):
            out.append(s["task_goal"])
        if s.get("instruction_text"):
            out.append(s["instruction_text"])
        return out[:2]
    except Exception:
        return []


def generate_tomorrow() -> dict:

    items = []
    for g in _unfinished_goals():
        items.append({"text": f"接着做：{g}", "source": "unfinished", "confidence": 0.85})
    for tag in _top_tags(2):
        topic = tag.split(":", 1)[-1]
        if topic and topic != "misc":
            items.append({"text": f"可以聊聊上次那个{topic}", "source": "topic",
                          "confidence": 0.6})
    try:
        import memory_layers as ml
        procs = sorted(ml.list_procedural(), key=lambda x: x.get("confidence", 0), reverse=True)
        for p in procs[:1]:
            items.append({"text": p.get("rule", ""), "source": "habit",
                          "confidence": p.get("confidence", 0.6)})
    except Exception:
        pass
    seen, uniq = set(), []
    for it in items:
        if it["text"] and it["text"] not in seen:
            seen.add(it["text"])
            uniq.append(it)
    uniq = uniq[:3]

    payload = {
        "date": _date(), "created_at": _now(),
        "items": uniq,
        "note": "睡前想好的、明天可以自然提起的小事。不是待办清单，是想惦记的事。",
    }
    try:
        MEM_DIR.mkdir(parents=True, exist_ok=True)
        TOMORROW.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        ok = True
    except Exception:
        ok = False
    return {"ok": ok, "items": uniq, "date": payload["date"]}


def peek_tomorrow() -> list[dict]:

    try:
        d = json.loads(TOMORROW.read_text(encoding="utf-8"))
        if d.get("date") != _date():
            return []
        return [dict(x) for x in d.get("items", [])]
    except Exception:
        return []


def tomorrow_hint() -> str:

    items = peek_tomorrow()
    if not items:
        return ""
    top = max(items, key=lambda x: x.get("confidence", 0))
    txt = top.get("text", "")
    return f"[Subtle thought to carry] {txt}" if txt else ""


def consolidate_all() -> dict:

    with _LOCK:
        result = {
            "at": _now(),
            "compress": compress_memory(),
            "habits": form_habits(),
            "tomorrow": generate_tomorrow(),
        }
        result["ok"] = bool(result["compress"].get("ok") and result["tomorrow"].get("ok"))
        try:
            MEM_DIR.mkdir(parents=True, exist_ok=True)
            with open(CONSOLIDATE_LOG, "a", encoding="utf-8") as f:
                f.write(json.dumps(result, ensure_ascii=False) + "\n")
        except Exception:
            pass
        return result


def status() -> dict:
    try:
        d = json.loads(TOMORROW.read_text(encoding="utf-8"))
        return {"tomorrow_date": d.get("date"), "tomorrow_count": len(d.get("items", [])),
                "hint": tomorrow_hint()}
    except Exception:
        return {"tomorrow_date": None, "tomorrow_count": 0, "hint": ""}
