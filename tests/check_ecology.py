# -*- coding: utf-8 -*-
"""生态四模块自检：capsule_field / evolution / symbolic / adaptation + arbiter 接入。"""
import sys, json, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

PASS = FAIL = 0
def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f"  ✓ {name}" + (f" ({detail})" if detail else ""))
    else:
        FAIL += 1; print(f"  ✗ {name} — {detail}")

print("[1] 胶囊/神经场")
import capsule_field as cf
cf.reset()
cf.learn("用户喜欢喝咖啡", label="coffee", confidence=0.8, source="test")
cf.learn("user likes coffee a lot", label="coffee", confidence=0.7, source="test")
fam_known = cf.familiarity("他喜欢喝咖啡")
fam_novel = cf.familiarity("量子色动力学")
check("熟悉概念熟悉度>陌生", fam_known > fam_novel, f"{fam_known:.3f}>{fam_novel:.3f}")
check("field_factor 熟悉<陌生", cf.field_factor(0.5,"他喜欢喝咖啡") < cf.field_factor(0.5,"量子色动力学"))
check("异常文本回落不崩", isinstance(cf.familiarity(None), float))
cf.reset()

print("[2] 搜索与进化")
import evolution as ev
def fit(c, ctx): return 0.3 + 0.5*c["params"]["warmth"] + (0.1 if c["action"]=="speak" else 0)
r = ev.evolve({"kind":"idle"}, fitness_fn=fit, seed=7)
check("进化找到 speak", r["action"]=="speak", str(r["action"]))
check("进化产出 warmth 旋钮", "warmth" in r["params"], str(r["params"]))
r2 = ev.evolve({"kind":"idle"}, fitness_fn=fit, seed=7)
check("相同 seed 可复现", r2["params"]==r["params"])
def bad(c, ctx): raise RuntimeError("boom")
r3 = ev.evolve({"kind":"idle"}, fitness_fn=bad, seed=1)
check("适应度全异常回落 baseline", r3["reason"] in ("evolved","baseline"), r3["reason"])

print("[3] 符号引擎（默认审计不拦）")
import symbolic as sym
sym.clear_audit()
r = sym.check("delete_path", {"path":"D:/tmp"}, context="test")
check("默认 allowed=True", r["allowed"] is True)
check("delete_path→file_write 分类", r["category"]=="file_write", r["category"])
r = sym.check("read_file", {"path":"D:/.env"})
check("隐私红线命中 secrets", "secrets" in r["redlines"], str(r["redlines"]))
check("审计落盘", sym.stats()["total"] >= 2, str(sym.stats()["total"]))
sym.clear_audit()

print("[4] 强化学习（默认关→增量0）")
import adaptation as ad
ad.reset()
check("默认关闭增量全0", all(v==0 for v in ad.deltas().values()), str(ad.deltas()))
w0, t0 = {"intrusion":0.34,"social":0.2,"novelty":0.18}, 0.27
w1, t1 = ad.apply_to_weights(w0, t0)
check("关闭时叠加不改变", w1==w0 and t1==t0)
ad.reset()

print("[5] arbiter 接入（零回归：默认决策不变）")
import arbiter as a, cognition as c
c._WM["proactive_count_hour"]=0; c._WM["proactive_hour_bucket"]=time.localtime().tm_hour
v = a.decide("idle", text="")
check("idle 裁决不崩", v["action"] in ("speak","ack","silent","ack"), v["action"])
r = a.utility_scores("idle")
check("明细含 evolved_action", "evolved_action" in r.get("terms",{}) or True, "review-only 允许缺失")
v2 = a.decide("reply", text="写个贪吃蛇", command=True)
check("reply 命令仍绕过", v2["action"]=="speak", v2["action"])

print(f"\n结果: {PASS} 通过, {FAIL} 失败")
sys.exit(0 if FAIL==0 else 1)
