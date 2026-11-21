# -*- coding: utf-8 -*-
from __future__ import annotations

import re
import threading
from difflib import SequenceMatcher

__all__ = [
    "correct_asr_text",
    "deterministic_fix",
    "detect_suspects",
    "needs_llm_correction",
    "history_proper_nouns",
    "run_with_deadline",
    "CANONICAL_NAMES",
    "MISHEARD_VARIANTS",
]


CANONICAL_NAMES = ("Neuro", "user")

MISHEARD_VARIANTS = {
    "naro": "Neuro",
    "nero": "Neuro",
    "niro": "Neuro",
    "neroo": "Neuro",
    "nuro": "Neuro",
    "nauro": "Neuro",
    "neuru": "Neuro",
    "neuroo": "Neuro",
    "nioro": "Neuro",
}

SAFE_NEAR_NAMES = frozenset({
    "neural", "neuron", "neurons", "neuralnetwork", "nerve", "nerves",
    "nervous", "neurotic", "neurosis", "neuroses", "neurotransmitter",
    "neurotransmitters", "neurology", "neurological", "neurofeedback",
    "narrow", "narrows", "narrowed", "narrower", "narrowest", "narrowly",
    "narrowness", "narrowing", "near", "nearer", "nearest", "nearly",
    "new", "newer", "newest", "news", "newt", "neon", "nerd", "nerds",
    "euro", "zero", "hero", "heroes", "nude", "nuke", "nun", "nuns",
    "none", "nonsense", "north", "nose", "noses", "note", "notes",
    "noun", "nouns", "nurse", "nurses", "nursing", "numeric", "navy",
    "naval", "navel", "noise", "noose", "node", "nodes", "nooks",
})

FUZZY_MIN = 0.72

HISTORY_FUZZY_MIN = 0.75

MIN_FUZZY_LEN = 4

LLM_TIMEOUT_S = 2.5

MIN_HISTORY_NAME_LEN = 4

MAX_HISTORY_NAMES = 40

_HISTORY_STOP_CAPS = frozenset("""
i a an the and but or nor so if then than that this these those there here
you your yours we our ours they them their he him his she her hers it its
what when where why who whom which how do does did done is are was were be
been being am can could would should will shall may might must have has had
yes no not ok okay alright right wrong sure yeah yep nope hmm um uh er oh ah
eh hey hi hello thanks thank sorry well also because while after before
until since for from with about into onto over under again once twice even
ever never always still yet already almost enough perhaps probably actually
basically honestly anyway indeed exactly really very quite rather maybe
let lets let\'s telling tell said say says going go goes go gone want wants
need needs think thinks thought make makes made take takes took give gives
gave use uses used find finds found keep keeps kept help helps work works
like likes love loves hate hates feel feels look looks see sees saw know
knows knew come comes came get gets got run runs walk walks sleep sleeps
good great nice cool awesome perfect worse worst better best first second
third next last same different new old big small long short easy hard fast
slow quiet loud late early today tomorrow yesterday morning evening night
time year day week month people world life home house room door window car
food water air fire earth sun moon star sky sea river tree flower money
love hate fear hope wish sorry thank please hello bye ok yes no now
""".split())

_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z'\-]*")
_CAP_TOKEN_RE = re.compile(r"[A-Z][A-Za-z0-9]{2,}(?:'[A-Za-z]+)?")


def _ratio(a: str, b: str) -> float:

    try:
        return SequenceMatcher(None, a, b).ratio()
    except Exception:
        return 0.0


def _norm_token(tok: str) -> str:

    t = (tok or "").strip().lower()
    if t.endswith("'s") or t.endswith("’s"):
        t = t[:-2]
    return t.strip("'")


def _iter_words(text: str):

    return _TOKEN_RE.findall(text or "")


def deterministic_fix(text: str):

    if not text:
        return (text or "", [])
    out = text
    hits = []

    def _canon(m):
        hits.append((m.group(0), "Neuro"))
        return "Neuro"

    out = re.sub(r"(?<![A-Za-z])neuro(?![A-Za-z])", _canon, out, flags=re.IGNORECASE)

    for wrong, right in MISHEARD_VARIANTS.items():
        def _fix(m, _r=right):
            hits.append((m.group(0), _r))
            return _r

        out = re.sub(
            r"(?<![A-Za-z])" + re.escape(wrong) + r"(?![A-Za-z])",
            _fix, out, flags=re.IGNORECASE,
        )

    def _cmd(m):
        hits.append((m.group(0), "user"))
        return "user"

    out = re.sub(r"(?<![A-Za-z])(?:cmd|user)(?![A-Za-z])", _cmd, out, flags=re.IGNORECASE)

    return (out, hits)


def history_proper_nouns(history) -> list:

    if not history:
        return []
    chunks = []
    for item in history:
        if isinstance(item, dict):
            chunks.append(str(item.get("content") or ""))
        else:
            chunks.append(str(item or ""))
    text = "\n".join(chunks)
    if not text:
        return []

    found = []
    seen = set()
    for m in _CAP_TOKEN_RE.finditer(text):
        tok = m.group(0)
        low = tok.lower()
        if low in _HISTORY_STOP_CAPS:
            continue
        if len(tok) < MIN_HISTORY_NAME_LEN:
            continue
        if low in {n.lower() for n in CANONICAL_NAMES}:
            continue
        if low in seen:
            continue
        seen.add(low)
        found.append(tok)
        if len(found) >= MAX_HISTORY_NAMES:
            break
    return found


def detect_suspects(text: str, history=None) -> list:

    out = []
    if not text:
        return out
    words = _iter_words(text)
    if not words:
        return out

    for tok in words:
        low = _norm_token(tok)
        if len(low) < MIN_FUZZY_LEN or low in SAFE_NEAR_NAMES:
            continue
        for name in CANONICAL_NAMES:
            if len(name) < MIN_FUZZY_LEN:
                continue
            nl = name.lower()
            if low == nl:
                continue
            r = _ratio(low, nl)
            if r >= FUZZY_MIN:
                out.append((tok, f"近似专名 {name}（相似度 {r:.2f}）"))
                break

    if not out:
        for cand in history_proper_nouns(history):
            cl = cand.lower()
            for tok in words:
                low = _norm_token(tok)
                if len(low) < MIN_FUZZY_LEN or low == cl:
                    continue
                r = _ratio(low, cl)
                if r >= HISTORY_FUZZY_MIN:
                    out.append((tok, f"与历史专名 {cand} 高度相似但不相等（相似度 {r:.2f}）"))
                    break
    return out


def needs_llm_correction(text: str, history=None) -> bool:

    return bool(detect_suspects(text, history))


def run_with_deadline(fn, args=(), timeout: float = LLM_TIMEOUT_S):

    box = {"value": None, "error": None}

    def _worker():
        try:
            box["value"] = fn(*args)
        except Exception as e:
            box["error"] = e

    th = threading.Thread(target=_worker, name="asr-corrector-llm", daemon=True)
    th.start()
    th.join(timeout)
    if th.is_alive():
        return (None, f"超时（>{timeout:.1f}s）")
    if box["error"] is not None:
        return (None, f"异常：{box['error']}")
    return (box["value"], None)


def correct_asr_text(raw: str, history=None, llm_corrector=None,
                     timeout: float = LLM_TIMEOUT_S) -> dict:

    raw_text = "" if raw is None else str(raw)
    if not raw_text.strip():
        return {"text": raw_text, "changed": False, "reason": "空文本，跳过", "suspects": []}

    try:
        fixed, hits = deterministic_fix(raw_text)
    except Exception as e:
        fixed, hits = raw_text, []

    base_reason = "无需修正"
    if hits:
        base_reason = "确定性修正 " + "、".join(f"{a}→{b}" for a, b in hits)

    try:
        suspects = detect_suspects(fixed, history)
    except Exception:
        suspects = []

    if not suspects:
        return {
            "text": fixed,
            "changed": fixed != raw_text,
            "reason": base_reason,
            "suspects": [],
        }

    suspect_reason = "；".join(f"{w}({why})" for w, why in suspects)

    if llm_corrector is None:
        return {
            "text": fixed,
            "changed": fixed != raw_text,
            "reason": f"{base_reason}；疑似专名错听但未启用 LLM 层：{suspect_reason}",
            "suspects": suspects,
        }

    try:
        value, err = run_with_deadline(llm_corrector, (fixed, history), timeout=timeout)
    except Exception as e:
        value, err = None, f"异常：{e}"

    if err:
        return {
            "text": fixed,
            "changed": fixed != raw_text,
            "reason": f"{base_reason}；LLM 纠错{err}，回落第一层结果；疑似：{suspect_reason}",
            "suspects": suspects,
        }
    if not value or not str(value).strip():
        return {
            "text": fixed,
            "changed": fixed != raw_text,
            "reason": f"{base_reason}；LLM 未给出可用结果，回落第一层结果；疑似：{suspect_reason}",
            "suspects": suspects,
        }

    fixed2 = str(value).strip()
    if fixed2 == fixed:
        return {
            "text": fixed,
            "changed": fixed != raw_text,
            "reason": f"{base_reason}；LLM 未改动（疑似：{suspect_reason}）",
            "suspects": suspects,
        }
    return {
        "text": fixed2,
        "changed": fixed2 != raw_text,
        "reason": f"{base_reason}；LLM 已纠正；疑似：{suspect_reason}",
        "suspects": suspects,
    }
