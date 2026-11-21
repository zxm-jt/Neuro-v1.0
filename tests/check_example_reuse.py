# -*- coding: utf-8 -*-
"""tests/check_example_reuse.py —— 复读检测器"""
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
# 示例对话的正式位置是 llm.persona_examples（前端单独注入一段），
# 老配置可能还写在 system_prompt 里 —— 优先取前者，取不到再退回后者。
pe = (cfg["llm"].get("persona_examples") or "")
sp = (cfg["llm"].get("system_prompt") or "")
src = pe if "EXAMPLE DIALOGUES" in pe else sp

print("[1] 能从示例对话里抽出示例回复")
ex = er.extract_example_replies(src)
if not ex:
    print("  SKIP  示例对话为空（config.llm.persona_examples 未填写），跳过示例相关断言")
else:
    ck("抽出 >= 3 条示例", len(ex) >= 3, f"实际 {len(ex)}")
ck("示例不含'user:'行（只取 Neuro 的回复）", not any("user:" in e for e in ex))
ck("示例都是非空短句（>= 12 字符，符合新示例风格）",
   all(len(e) >= 12 for e in ex),
   f"最短 {min((len(e) for e in ex), default=0)}")
ck("示例里没有情绪标签（标签不是台词，已被剥掉）",
   not any("[" in e or "]" in e for e in ex))
if ex:
    print(f"        示例 1: {ex[0][:60]}")

print("\n[2] 复读能被发现")
if ex:
    reused, sim, hit = er.check_reuse(ex[0], ex)
    ck("示例原句被判为复读", reused, f"相似度 {sim:.2f}")
    ck("命中的是它自己", hit == ex[0])

print("\n[3] 原创回复不该被误判")
originals = [
    "The plants have a very strong opinion about this. Have you gone to check on them?",
    "Oh no, the betrayal. Was it a dignified death or did it just go silent mid-word?",
    "Because nothing verifies the pipe is alive - your writer assumes it's fine.",
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
# 示例所在的文本段（persona_examples 优先）——软拦截就是在这段上做删除
pairs = er.extract_example_pairs(src)
if not pairs:
    print("  SKIP  示例对话为空，跳过软拦截断言")
else:
    ck("能抽出成对的 (user, reply)", len(pairs) >= 3, f"实际 {len(pairs)}")
if pairs:
    sample_cmd = pairs[0][0]
    hit, user = er.find_colliding_example(sample_cmd, src)
    ck("示例台词本身被判为撞上", hit, str(user)[:40])
    new_sp, ok = er.strip_example_from_prompt(src, user)
    ck("挖掉成功", ok)
    ck("挖掉后该台词不在 prompt 里", user[:30] not in new_sp)
    ck("挖掉后其它示例还在", len(er.extract_example_replies(new_sp)) >= len(ex) - 1,
       f"剩 {len(er.extract_example_replies(new_sp))}（挖之前 {len(ex)}）")
    import re as _re
    _before = len(_re.findall(r"^### ", src, _re.M))
    _after = len(_re.findall(r"^### ", new_sp, _re.M))
    ck("只挖掉了一个示例块（没误删别的）", _after == _before - 1,
       f"{_before} → {_after}")
    ck("挖掉后 prompt 变短", len(new_sp) < len(sp))
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
