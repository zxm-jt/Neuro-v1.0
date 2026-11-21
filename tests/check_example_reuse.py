#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""tests/check_example_reuse.py —— 复读检测器

【背景】ChatGPT 要求她不能机械复用示例的措辞。提示词里写了禁止，
但实测当用户输入与示例几乎逐字相同时，模型会复读。这里测检测器本身。

跑法：python tests/check_example_reuse.py
"""
import importlib.util
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

spec = importlib.util.spec_from_file_location(
    "er", os.path.join(ROOT, "backend", "example_reuse.py"))
er = importlib.util.module_from_spec(spec)
spec.loader.exec_module(er)

PASS = FAIL = 0


def ck(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}  {detail}")


with open(os.path.join(ROOT, "config.json"), encoding="utf-8") as f:
    cfg = json.load(f)
# 示例对话的正式位置是 llm.persona_examples（前端单独注入一段 system，
# 不塞进 system_prompt，免得 7.5K 示例稀释掉人格主体）。旧配置可能还写在
# system_prompt 里 —— 优先取前者，取不到再退回后者。
pe = (cfg["llm"].get("persona_examples") or "")
sp = (cfg["llm"].get("system_prompt") or "")
src = pe if "EXAMPLE DIALOGUES" in pe else sp

print("[1] 能从示例对话里抽出示例回复")
ex = er.extract_example_replies(src)
# 【2026-11-05 更新】示例由 25 组精简为 5 组（用户要求"精简人格"，示例只作"形状"参考）。
# 5 组里部分是纯表情轮次（剥标签后无台词），故台词库 >= 3 即为正常。
ck("抽出 >= 3 条示例", len(ex) >= 3, f"实际 {len(ex)}")
ck("示例不含'cmd:'行（只取 Neuro 的回复）", not any("cmd:" in e for e in ex))
# 【2026-11-01 改动】旧断言是"每条都 > 25 字符"—— 那是因为旧示例全是长句。
# 新提示词的示例【刻意很短】（"I know."、"Okay."），一半只有一两个词。
# 复读检测最该盯的就是短句（长句模型记不住原样，短句它会照抄），
# 所以门槛从 25 降到 12，让短句也能进比对库。
ck("示例都是非空短句（>= 12 字符，符合新示例风格）",
   all(len(e) >= 12 for e in ex),
   f"最短 {min((len(e) for e in ex), default=0)}")
ck("示例里没有情绪标签（标签不是台词，已被剥掉）",
   not any("[" in e or "]" in e for e in ex))
if ex:
    print(f"        示例 1: {ex[0][:60]}")

print("\n[2] 复读能被发现")
if ex:
    # 【2026-11-06】显式传入示例库：check_reuse() 不带 examples 时会去
    # import neuro_server 取缓存，而测试用的 python 没装 numpy → 返回空库。
    # 这里测的是"检测器本身"，不该依赖后端运行时环境。
    reused, sim, hit = er.check_reuse(ex[0], ex)
    ck("示例原句被判为复读", reused, f"相似度 {sim:.2f}")
    ck("命中的是它自己", hit == ex[0])

print("\n[3] 原创回复不该被误判")
originals = [
    "The plants have a very strong opinion about this. Have you gone to check on them?",
    "Oh no, the betrayal. Was it a dignified death or did it just go silent mid-word?",
    "Because nothing verifies the pipe is alive - your writer assumes it's fine.",
    # 【注意】不要用示例里的原句当"原创"用例 —— 那本来就会被判复读
    "Honestly? That reads like a problem statement, not a plan.",
    "Bold of you to assume I notice when you leave the room.",
]
for o in originals:
    reused, sim, _ = er.check_reuse(o, ex)
    ck(f"原创不被误判: \"{o[:40]}...\"", not reused, f"相似度 {sim:.2f}")

print("\n[4] 边界情况")
ck("空文本不复读", er.check_reuse("", ex)[0] is False)
ck("极短文本不复读", er.check_reuse("Ok.", ex)[0] is False)
ck("纯标点不复读", er.check_reuse("...", ex)[0] is False)
ck("无示例时全部放行", er.check_reuse("x" * 40, examples=[])[0] is False)


print("\n[5] 软拦截：用户输入撞上示例 → 该示例被挖掉")
pairs = er.extract_example_pairs(src)
# 【2026-11-05 同步】人格精简后示例块由 25 组收敛到 5 组（用户要求精简），
# 这里与 [3] 的 ">= 3 条" 保持一致，不再要求旧版的 >= 15 对。
ck("能抽出成对的 (cmd, reply)", len(pairs) >= 3, f"实际 {len(pairs)}")
if pairs:
    sample_cmd = pairs[0][0]
    hit, cmd = er.find_colliding_example(sample_cmd, src)
    ck("示例台词本身被判为撞上", hit, str(cmd)[:40])
    new_sp, ok = er.strip_example_from_prompt(src, cmd)
    ck("挖掉成功", ok)
    ck("挖掉后该台词不在 prompt 里", cmd[:30] not in new_sp)
    # 【2026-11-01 改动】旧断言拿【回复条数】跟【cmd/回复对数】比 ——
    # 两者本来就不是一回事：有些示例是纯表情轮次（剥掉标签后没有台词），
    # 不进回复库。正确比法：跟挖之前的回复条数比，最多少一条。
    ck("挖掉后其它示例还在", len(er.extract_example_replies(new_sp)) >= len(ex) - 1,
       f"剩 {len(er.extract_example_replies(new_sp))}（挖之前 {len(ex)}）")
    # 更硬的检查：示例【块】的数量恰好少了一个（没有误删别的块）
    import re as _re
    _before = len(_re.findall(r"^### \d+\.", src, _re.M))
    _after = len(_re.findall(r"^### \d+\.", new_sp, _re.M))
    ck("只挖掉了一个示例块（没误删别的）", _after == _before - 1,
       f"{_before} → {_after}")
    ck("挖掉后 prompt 变短", len(new_sp) < len(sp))
    # 不撞上的输入不该被拦截
    hit2, _ = er.find_colliding_example("my keyboard just died mid sentence", src)
    ck("不撞上的输入不拦截", not hit2)

print("\n[6] 非流式路径的 NameError 已修（llm_complete 的参数）")
ab = ""
ap = os.path.join(ROOT, "backend", "agent_bridge.py")
if os.path.exists(ap):
    with io.open(ap, encoding="utf-8") as f:
        ab = f.read()
ck("llm_complete 有 max_tokens_override 参数",
   "def llm_complete(cfg, messages, retries=4, max_tokens_override=None)" in ab)
ck("非流式路径也做了示例软拦截",
   ab.count("find_colliding_example") >= 2)
# 【2026-11-21】示例已从 system_prompt 拆到前端单独注入的一段 system。
# 所以软拦截必须遍历所有 system 段；只看第一条 = 永远扫不到示例 = 闸门失效。
ck("软拦截遍历所有 system 段（不只看第一条）",
   "for _m in msgs:" in ab and "_sys_msg = _m" not in ab)

print(f"\n结果：{PASS} PASS / {FAIL} FAIL")
sys.exit(0 if FAIL == 0 else 1)
