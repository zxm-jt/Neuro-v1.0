import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("  PASS " if cond else "  FAIL ") + name + (f"  [{detail}]" if detail else ""))


print("=" * 62)
print("8 层架构 · 全模块自检（阶段1-5）")
print("=" * 62)

print("\n[L4 记忆分层]")
import memory_layers as ml
st = ml.layer_stats()
check("四层统计可查", set(ml.LAYERS).issubset(set(st.keys())), str(st))
check("分类：语义", ml.classify_layer("user 说他喜欢咖啡") == "semantic")
check("分类：程序", ml.classify_layer("每次我说开始你都要先确认") == "procedural")
check("分类：情景", ml.classify_layer("今天看到了一个新窗口") == "episodic")
ml.add_procedural("测试规则_X", confidence=0.5)
ml.add_procedural("测试规则_X")
_rule_x = [x for x in ml.list_procedural() if x.get("rule") == "测试规则_X"][0]
check("程序记忆强化", _rule_x["confidence"] > 0.5, f"confidence={_rule_x['confidence']}")
frags = ml.load_layered_fragments()
check("片段有元数据", all("layer" in f and "confidence" in f for f in frags[:3]))

print("\n[L6 反思日志]")
import reflection as rf
rf.log_decision("idle", "speak", reason="selftest", token="selftest_token")
resp = rf.on_user_reaction(kind="responded")
check("决策记录+回填", resp is True)
s = rf.stats()
check("统计字段齐全", all(k in s for k in ["intrusion_rate", "relevance_rate", "proactive_last_hour"]))

print("\n[L5 习惯化]")
import habituation as hab
hab.reset()
key = "selftest:重复刺激"
v0 = hab.response(key)
for _ in range(5):
    hab.stimulate(key, strength=1.0)
v1 = hab.response(key)
check("重复刺激→反应衰减", v1 < v0, f"{v0:.2f}→{v1:.2f}")
time.sleep(0.05)
check("反应系数有下限", v1 >= hab._FLOOR, f"{v1:.2f}")

print("\n[L8 离线巩固]")
import consolidation as co
r = co.generate_tomorrow()
check("明日意图生成", r["ok"] and isinstance(r["items"], list), str(len(r["items"])) + " 件")
check("明日意图可读", isinstance(co.peek_tomorrow(), list))
check("提示可生成", isinstance(co.tomorrow_hint(), str))
check("习惯提炼可执行", isinstance(co.form_habits()["formed"], list))

print("\n[L5 身体闭环]")
import body_loop as bl
import cognition as cg
for n in cg.DRIVE_NAMES:
    cg.drive_set(n, cg._DV_FALLBACK["base"][n])
cg.drive_set("boredom", 0.9)
cg.drive_set("rest", 0.2)
loop = bl.close_loop()
check("内部状态触发动作", loop is not None and loop["action"] == "look",
      loop["action"] if loop else "None")
if loop:
    check("动作回灌降低无聊", loop["after"]["boredom"] < loop["before"]["boredom"],
          f"{loop['before']['boredom']:.2f}→{loop['after']['boredom']:.2f}")
    check("动作回灌提升好奇", loop["after"]["curiosity"] > loop["before"]["curiosity"],
          f"{loop['before']['curiosity']:.2f}→{loop['after']['curiosity']:.2f}")
for a in ["look", "speak", "expression", "motion", "headpat", "rest", "withdraw"]:
    check(f"动作可回灌:{a}", bl.act(a)["ok"])

print("\n[清理]")
try:
    lines = rf.LOG.read_text(encoding="utf-8").splitlines()
    kept = [ln for ln in lines if "selftest" not in ln]
    rf.LOG.write_text("\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")
    d = ml._load_proc()
    d["items"] = [x for x in d["items"] if x.get("rule") != "测试规则_X"]
    ml._save_proc(d)
    print("  临时数据已清理")
except Exception as e:
    print("  清理跳过:", e)

print("-" * 62)
print(f"结果: {len(PASS)} PASS / {len(FAIL)} FAIL")
if FAIL:
    print("失败项:", FAIL)
    sys.exit(1)
print("ALL PASS")
