import io
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import agent_bridge as ab
import vision_manager as vm

PASS = 0
FAIL = 0


def ck(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  \u2713 " + name)
    else:
        FAIL += 1
        print("  \u2717 FAIL: " + name + (f"  ({extra})" if extra else ""))


def rd(rel):
    with io.open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


print("\n[A] 每轮重述块（长对话不被遗忘的总闸）")
ab.task_reset()
_out = ab.inject_tools([{"role": "system", "content": "PERSONA"},
                        {"role": "user", "content": "hi"}])
_sys = _out[0]["content"]
ck("无任务时每轮带 LIVE RULES", "LIVE RULES - re-stated EVERY turn" in _sys)
ck("铁律重述：代码只写不念", "NEVER spoken" in _sys)
ck("铁律重述：type_text 后必须 Enter", "key_press enter" in _sys)
ck("铁律重述：记忆不主动复述", "never open with them" in _sys)
ck("无任务时不带 ONGOING TASK", "ONGOING TASK" not in _sys)

ab.task_start(intent="open deepseek", goal="Open DeepSeek and type hello",
              app="deepseek harness", steps=["s1", "s2", "s3"])
_out2 = ab.inject_tools([{"role": "system", "content": "PERSONA"},
                         {"role": "user", "content": "继续"}])
_sys2 = _out2[0]["content"]
ck("有任务时每轮带 ONGOING TASK", "[ONGOING TASK - re-stated EVERY turn]" in _sys2)
ck("进度目标每轮可见", "Open DeepSeek and type hello" in _sys2)
ck("step 进度每轮可见", "Progress (0/3)" in _sys2)


print("\n[B] 持续任务：完成判据 / 取消 / 催促")
ab.task_reset()
ab.task_start(intent="open deepseek", goal="g", app="deepseek harness",
              steps=["space#1", "space#2", "space#3", "click", "type", "enter"])
for _ in range(6):
    ab.task_advance()
ck("6 个推进型 op 走完 → active=False（旧版 step 数 8 永远不结束）",
   ab.TASK["active"] is False)

ab.task_reset()
ab.task_start(intent="x", goal="g", app="a", steps=["s1", "s2"])
ck("用户说「算了」→ 立即 reset", ab.task_tick("算了") is True and not ab.TASK["active"])
ab.task_start(intent="x", goal="g", app="a", steps=["s1", "s2"])
ck("用户说「stop」→ 立即 reset", ab.task_tick("stop") is True and not ab.TASK["active"])
ab.task_start(intent="x", goal="g", app="a", steps=["s1", "s2"])
ck("催促「go ahead」不误杀（旧版会腰斩）",
   ab.task_tick("go ahead") is False and ab.TASK["active"] is True)
ab._maybe_advance_task("key_press", "go ahead")
ck("催促轮不推进 step（保持在原步骤）", ab.TASK["step_idx"] == 0)

ab.task_reset()
ab.task_start(intent="x", goal="g", app="a", steps=["s1", "s2"])
ab.TASK["updated_at"] = time.time() - (ab.TASK_STALE_S + 10)
ck("超过 TTL 无推进 → 僵尸任务被清掉",
   ab.task_tick("嗯") is True and not ab.TASK["active"])
ab.task_reset()


print("\n[C] 桌面回执：有界 / 自带 op / 失败不催继续")
ab._DESKTOP_OP_BY_ID.clear()
for i in range(300):
    ab._remember_desktop_op("id%d" % i, "type_text")
ck("_DESKTOP_OP_BY_ID 有界（<=256）", len(ab._DESKTOP_OP_BY_ID) <= 256,
   str(len(ab._DESKTOP_OP_BY_ID)))
ck("回执自带 op 时后端重启也能反查（不再复述打字内容）",
   ab._take_desktop_op({"id": "nonexistent", "op": "key_press"}) == "key_press")
ab._remember_desktop_op("realid", "type_text")
ck("正常回执能取回 op", ab._take_desktop_op({"id": "realid"}) == "type_text")
_ff = ab._desktop_follow_instr({"ok": False, "id": "x"})
ck("失败回执明确不许继续下一步", "do NOT output another tool call" in _ff)
ck("失败回执不再宣称动作已执行", "the action you just performed" not in _ff)
_sf = ab._desktop_follow_instr({"ok": True, "id": "y"}, "type_text")
ck("成功回执仍走 _follow_prompt（继续链接）", "one line" in _sf)


print("\n[D] 识图：过期不再断崖归零，也不伪装成此刻")
try:
    mgr = vm.VisionManager()
    mgr.clear_observations()
    ck("无观察时返回空串", mgr.observation_context() == "")
    mgr.observations.append(vm.Observation("user had VS Code open", time.time() - 900,
                                           "proactive"))
    stale = mgr.observation_context()
    ck("全过期时不再返回空（旧版视觉整段蒸发）", bool(stale.strip()))
    ck("明确标注已过期、不许声称此刻还看到",
       "NO LONGER current" in stale and "Do NOT claim you still see it" in stale)
    ck("带 STALE 时间戳", "STALE" in stale)
    ck("仍保留最近一条内容供回想", "VS Code" in stale)
    mgr.observations.append(vm.Observation("user is in the browser", time.time(), "proactive"))
    fresh = mgr.observation_context()
    ck("有新鲜观察时走正常 right now 格式",
       "What you can see on user's screen right now" in fresh)
except Exception as e:
    ck("视觉观察用例可执行", False, str(e))

_ns = rd("backend/neuro_server.py")
ck("视觉上下文插进首条 system（不再 append 末尾降权）",
   'messages.insert(0, {"role": "system", "content": _vctx.strip()})' in _ns
   and "messages.append({\"role\": \"system\", \"content\": _vctx})" not in _ns)


print("\n[E] 延迟：会话总结 / 插话 LLM 移出事件循环")
ck("session_end 走 run_in_threadpool",
   "await run_in_threadpool(memory_system.session_end, msgs)" in _ns)
ck("视觉插话 LLM 走 asyncio.to_thread",
   "await asyncio.to_thread(" in _ns and "vp.speak_from_observation, cfg, base" in _ns)
_cg = rd("backend/cognition.py")
ck("idle 搭话纳入统一主动预算（arbiter/cognition 一份，不再叠视觉配额）",
   "proactive_hourly_cap()" in _cg
   and "hourly_proactive_cap" in _cg
   and "_vision_speak_budget_ok(_vcap)" not in _ns)

_ms = rd("backend/memory_system.py")
ck("总结请求 timeout 与 deadline 对齐（假 20s 截止已修）",
   "urlopen(req, timeout=deadline_s)" in _ms and "shutdown(wait=False, cancel_futures=True)" in _ms)
_vm_src = rd("backend/vision_manager.py")
ck("视觉观察有总超时预算（防主+fallback 串行 16s）",
   "asyncio.wait_for(" in _vm_src)
ck("补帧最多一次且受 min_interval 节流（防无限补看链）",
   "_catchup" in _vm_src and "not _catchup and self._running" in _vm_src)

import json as _json
_cfg = _json.loads(rd("config.json"))
ck("memory.timeout_s 已显式配置（不再吃默认 6s）",
   _cfg["memory"].get("timeout_s") == 2)
ck("observation_context_window_s 已显式配置",
   _cfg["vision"]["free"].get("observation_context_window_s") == 600)

print("\n[F] 持续跟进：follow-up 轮不再吞掉 tool 事件")
import json as _json2
ab.task_reset()
ab._CHAIN.update({"count": 0, "since": 0.0, "task": None})
ck("无进行中任务时不自动链接（闲聊行为不变）", ab._allow_chain() is False)
ab.task_start(intent="x", goal="g", app="a", steps=["s"] * 6)
ab._CHAIN.update({"count": 0, "since": 0.0, "task": None})
_allow = [ab._allow_chain() for _ in range(8)]
# 【2026-11-21 修复"每一步都要重复"】上限从固定 6 放宽到 3×步骤数（6 步→18），
# 给视觉定位/重试留余量；8 次调用都在上限内，应全 True。
ck("链接上限按任务步骤数放宽（6 步任务允许 18 次链接）",
   _allow == [True] * 8, str(_allow))

_ab_real_stream = ab.llm_stream
try:
    ab.task_reset()
    ab.task_start(intent="x", goal="g", app="a", steps=["s"] * 6)
    ab._CHAIN.update({"count": 0, "since": 0.0, "task": None})
    ab.llm_stream = lambda cfg, msgs, **kw: iter([
        ("emo", "neutral"),
        ("tool", _json2.dumps({"op": "key_press", "args": {"keys": "enter"}})),
    ])
    _ev = list(ab._stream_text_events(
        {}, [{"role": "system", "content": "s"}, {"role": "user", "content": "hi"}]))
    _cmd = next((e["desktop_cmd"] for e in _ev if "desktop_cmd" in e), None)
    ck("tool 事件转成 desktop_cmd 下发（旧版被静默吞掉）", _cmd is not None)
    ck("下发的是预期的桌面动作", bool(_cmd) and _cmd.get("op") == "key_press")
    ck("自动链接时任务进度会推进", ab.TASK["step_idx"] == 1)
finally:
    ab.llm_stream = _ab_real_stream
    ab.task_reset()

print("\n===== " + str(PASS) + " passed, " + str(FAIL) + " failed =====")
sys.exit(1 if FAIL else 0)
