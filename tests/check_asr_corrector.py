# -*- coding: utf-8 -*-
"""作用：验证"识别后、对话生成前"的 ASR 纠错层（任务 1）。"""
import os
import re
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import asr_corrector as ac  # noqa: E402

PASS = 0
FAIL = 0


def ck(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}  {detail}")


def sec(title):
    print(f"\n=== {title} ===")


sec("[1] 第一层：确定性修正（零延迟、零配额）")
for raw, want in [
    ("NARO told me something", "Neuro told me something"),
    ("Nero is here", "Neuro is here"),
    ("ask Niro about it", "ask Neuro about it"),
    ("Neroo said hi", "Neuro said hi"),
    ("nuro, come here", "Neuro, come here"),
    ("neuro is my name", "Neuro is my name"),
    ("NARO's idea", "Neuro's idea"),
]:
    got, hits = ac.deterministic_fix(raw)
    ck(f"确定性修正 {raw!r}", got == want, f"得到 {got!r}，期望 {want!r}")

# 词边界：绝不能误伤正常单词
for raw in [
    "narrow the search", "narrows down", "I feel nervous",
    "near the door", "neuroscience is fun", "Xnaro", "narop",
    "CMD is a shell", "the neuron fired",
]:
    got, _ = ac.deterministic_fix(raw)
    safe = raw in ("CMD is a shell",)
    ck(f"不误伤 {raw!r}", (got == raw) if not safe else (got == "user is a shell"),
       f"得到 {got!r}")

# 空输入 / None 安全
for raw in ("", "   ", None):
    try:
        got, hits = ac.deterministic_fix(raw)
        ck(f"空输入安全 {raw!r}", got == (raw or "") and hits == [], f"得到 {got!r}")
    except Exception as e:
        ck(f"空输入安全 {raw!r}", False, f"抛异常 {e}")

got, _ = ac.deterministic_fix("CMD and NEURO")
ck("user/neuro 大小写归一", got == "user and Neuro", f"得到 {got!r}")


sec("[2] 第二层触发判据（明确、可测的纯函数）")
for text in [
    "Hello there how are you",
    "Please narrow the search",
    "I feel nervous about it",
    "NARO told me to narrow the search",
    "The weather is nice today",
]:
    fixed, _ = ac.deterministic_fix(text)
    ck(f"普通句不触发 LLM {text!r}", not ac.needs_llm_correction(fixed),
       f"命中 {ac.detect_suspects(fixed)}")

for text in ["Neoro said hi", "Neuor is here", "Neuoro came back", "Neruo is here"]:
    ck(f"疑似错听触发 LLM {text!r}", ac.needs_llm_correction(text),
       f"未命中，detect={ac.detect_suspects(text)}")

hist = [{"role": "assistant", "content": "SenseVoice is running"}]
ck("历史专名触发", ac.needs_llm_correction("SenseVioce is running", hist),
   f"detect={ac.detect_suspects('SenseVioce is running', hist)}")
ck("历史专名一模一样不触发", not ac.needs_llm_correction("SenseVoice is running", hist))


sec("[3] 第二层：失败/超时/异常一律回落")
def _ok(text, history):
    return "Neuro told me so"


r = ac.correct_asr_text("Neoro told me so", history=[], llm_corrector=_ok)
ck("LLM 成功时采用纠正结果", r["text"] == "Neuro told me so" and r["changed"], str(r))

# 返回 None
r = ac.correct_asr_text("Neoro told me so", history=[], llm_corrector=lambda t, h: None)
ck("LLM 返回 None → 回落", r["text"] == "Neoro told me so", str(r))

# 抛异常
def _boom(text, history):
    raise RuntimeError("429 rate limited")


r = ac.correct_asr_text("Neoro told me so", history=[], llm_corrector=_boom)
ck("LLM 抛异常 → 回落且不抛", r["text"] == "Neoro told me so", str(r))

# 超时（用可调小的 timeout）
def _slow(text, history):
    time.sleep(0.5)
    return "should not be used"


t0 = time.time()
r = ac.correct_asr_text("Neoro told me so", history=[], llm_corrector=_slow, timeout=0.05)
elapsed = time.time() - t0
ck("LLM 超时 → 回落", r["text"] == "Neoro told me so", str(r))
ck("超时确实生效（不阻塞主链路）", elapsed < 0.45, f"耗时 {elapsed:.2f}s")

calls = []


def _counted(text, history):
    calls.append(text)
    return text


r = ac.correct_asr_text("narrow the search", history=[], llm_corrector=_counted)
ck("确定性/无需纠错时不打 LLM", len(calls) == 0 and r["text"] == "narrow the search",
   f"调用 {len(calls)} 次")

# correct_asr_text 对空输入与异常入参都不能炸
for raw in ("", None):
    try:
        r = ac.correct_asr_text(raw, history=None, llm_corrector=_boom)
        ck(f"主入口空输入安全 {raw!r}", r["text"] == (raw or ""), str(r))
    except Exception as e:
        ck(f"主入口空输入安全 {raw!r}", False, f"抛异常 {e}")


sec("[4] 端到端接缝：两条识别路径都调用了纠错层")
src = open(os.path.join(ROOT, "backend", "neuro_server.py"), encoding="utf-8").read()
ck("neuro_server 导入了 asr_corrector", "import asr_corrector" in src)
ck("定义了统一入口 _run_asr_corrector", "def _run_asr_corrector" in src)

import ast as _ast

_tree = _ast.parse(src)
_bodies = {}
for _n in _ast.walk(_tree):
    if isinstance(_n, (_ast.FunctionDef, _ast.AsyncFunctionDef)):
        _seg = _ast.get_source_segment(src, _n) or ""
        _bodies.setdefault(_n.name, []).append(_seg)

non_body = "\n".join(_bodies.get("asr", []))
st_body = "\n".join(_bodies.get("_transcribe_and_send", []))
ck("非流式 asr() 调用了纠错", "_run_asr_corrector" in non_body,
   "在 asr() 函数体里没找到调用")

# 流式路径：_transcribe_and_send 里必须在识别之后、send_json 之前纠错
has_call = "_run_asr_corrector" in st_body
ck("流式 _transcribe_and_send 调用了纠错", has_call,
   f"函数体长度 {len(st_body)}，前 200 字: {st_body[:200]!r}")
if has_call:
    i_corr = st_body.find("_run_asr_corrector")
    i_send = st_body.find('"type": "utterance"')
    if i_send < 0:
        i_send = st_body.find('"type":"utterance"')
    ck("纠错在 utterance 下发【之前】", i_send < 0 or i_corr < i_send,
       f"纠错位置 {i_corr}，下发位置 {i_send}")

ck("BASE_PROMPT 含专名先验", "The AI companion's name is Neuro" in src)

# 冷却机制仍在（不能把限流保护改丢）
ck("保留了纠错冷却闸门", "_asr_correction_cooldown" in src and "_asr_correction_report" in src)
_bad_size = [
    n for n in _ast.walk(_tree)
    if isinstance(n, _ast.Call)
    and isinstance(n.func, _ast.Attribute)
    and n.func.attr == "size"
    and isinstance(n.func.value, _ast.Name)
    and "frame_q" in n.func.value.id
]
ck("保留了 asyncio.Queue.qsize 修复（实际代码没退回 .size()）", not _bad_size,
   f"发现 {len(_bad_size)} 处")


print(f"\n结果：{PASS} PASS / {FAIL} FAIL")
sys.exit(1 if FAIL else 0)
