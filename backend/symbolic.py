# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import time
import threading
from pathlib import Path

_LOCK = threading.RLock()
_STATE = Path(__file__).resolve().parent.parent / "memory" / "tool_audit.jsonl"

_FALLBACK = {"enabled": True, "enforce": False, "audit": True}

_CATEGORY = {
    "delete_path": "file_write", "move_path": "file_write",
    "launch_app": "shell", "cpp_run": "shell", "cpp_debug": "shell",
    "open_url": "network_post",
    "open_path": "read", "list_dir": "read", "search_files": "read",
    "read_file": "read", "grep_file": "read", "summarize_file": "read",
    "file_info": "read", "find_large_files": "read",
    "cpp_get_code": "read", "cpp_visual_inspect": "read",
}

_REDLINE_PAT = {
    "secrets": ("secret", "password", "凭据", "口令", "credential", ".env"),
    "api_key": ("api_key", "apikey", "api-key", "sk-", "token", "密钥"),
    "chat_log_raw": ("chat_log.txt", "chat_log_raw"),
    "user_files": ("identity", "文档/", "documents/", "desktop/", "下载/"),
}


def _cfg() -> dict:
    out = dict(_FALLBACK)
    try:
        c = json.loads((Path(__file__).resolve().parent.parent / "config.json").read_text(encoding="utf-8"))
        m = c.get("mind") or {}
        s = ((m.get("ecology") or {}).get("symbolic") or m.get("symbolic") or {})
        for k in _FALLBACK:
            if isinstance(s.get(k), bool):
                out[k] = s[k]
        u = ((c.get("mind") or {}).get("utility") or {})
        out["permissions"] = u.get("tool_permissions") or {}
        out["redlines"] = u.get("privacy_redlines") or []
    except Exception:
        out["permissions"] = {}
        out["redlines"] = []
    return out


def classify(op: str, args: dict | None = None) -> str:

    try:
        return _CATEGORY.get(str(op), "unknown")
    except Exception:
        return "unknown"


def _hit_redlines(args: dict, configured: list) -> list[str]:

    hits = []
    try:
        blob = json.dumps(args or {}, ensure_ascii=False).lower()
        for name in configured or []:
            pats = _REDLINE_PAT.get(str(name), (str(name).lower(),))
            if any(p.lower() in blob for p in pats):
                hits.append(str(name))
    except Exception:
        pass
    return hits


def check(op: str, args: dict | None = None, *, context: str = "") -> dict:

    cfg = _cfg()
    args = args or {}
    category = classify(op, args)
    warnings = []
    redlines = _hit_redlines(args, cfg.get("redlines"))

    if redlines:
        warnings.append("隐私红线命中: " + ",".join(redlines))

    deny = (cfg.get("permissions") or {}).get("deny") or []
    if category in deny or (cfg.get("permissions") or {}).get("*") is True:
        warnings.append(f"工具 {op} 属于被拒类别 {category}")

    enforced = bool(cfg["enforce"])
    allowed = True
    if enforced and (category in deny):
        allowed = False
        warnings.append("【已拦截】enforce=true 且类别被拒")

    result = {"allowed": allowed, "category": category, "warnings": warnings,
              "enforced": enforced, "redlines": redlines}

    if cfg["audit"]:
        try:
            rec = {"t": round(time.time(), 3), "op": str(op), "category": category,
                   "redlines": redlines, "allowed": allowed,
                   "context": str(context)[:80]}
            with _LOCK:
                _STATE.parent.mkdir(parents=True, exist_ok=True)
                with _STATE.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except Exception:
            pass
    return result


def guard(op: str, args: dict | None = None, *, context: str = "") -> tuple[bool, str]:

    try:
        r = check(op, args, context=context)
        return r["allowed"], "; ".join(r["warnings"])
    except Exception:
        return True, ""


def stats() -> dict:

    out = {"total": 0, "by_category": {}, "redline_hits": 0, "blocked": 0}
    try:
        if _STATE.exists():
            for ln in _STATE.read_text(encoding="utf-8").splitlines():
                try:
                    r = json.loads(ln)
                except Exception:
                    continue
                out["total"] += 1
                c = r.get("category", "unknown")
                out["by_category"][c] = out["by_category"].get(c, 0) + 1
                if r.get("redlines"):
                    out["redline_hits"] += 1
                if not r.get("allowed", True):
                    out["blocked"] += 1
    except Exception:
        pass
    return out


def clear_audit() -> bool:

    try:
        if _STATE.exists():
            _STATE.unlink()
        return True
    except Exception:
        return False


if __name__ == "__main__":
    clear_audit()
    print("delete_path:", check("delete_path", {"path": "D:/tmp"}, context="cleanup"))
    print("read api_key:", check("read_file", {"path": "D:/proj/.env"}))
    print("open_url:", check("open_url", {"url": "http://x"}))
    print("统计:", stats())
    print("SYMBOLIC OK")
