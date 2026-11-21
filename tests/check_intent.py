# -*- coding: utf-8 -*-
"""自主意图自检：果蝇脑驱动 + 意图连续性 + evolution 接管决策。"""
import sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

PASS = FAIL = 0
def check(name, cond, detail=""):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  ✓ {name}" + (f" ({detail})" if detail else ""))
    else: FAIL += 1; print(f"  ✗ {name} — {detail}")

print("[1] 意图基础（驱力驱动，脑未起）")
import intent as it, cognition as cg
it.reset()
for n in cg.DRIVE_NAMES: cg.drive_set(n, cg._DV_FALLBACK["base"][n])
cg.drive_set("social", 0.95); cg.drive_set("achievement", 0.1)
o = it.form(n_obs=0)
check("社交驱力→social 意图", o["type"] == "social", f"{o['type']} {o['strength']}")
check("意图带中文标签", bool(o.get("label")), o.get("label", ""))
check("social→speak 一致性>0", it.consistency("speak") > 0, str(round(it.consistency('speak'),3)))
check("social→wait 一致性<0", it.consistency("wait") < 0, str(round(it.consistency('wait'),3)))

print("[2] 意图连续性（懒惰更新，不每次重算）")
formed = it.current()["formed_at"]
cg.drive_set("social", 0.1); cg.drive_set("achievement", 0.95)
o2 = it.form(n_obs=0)
check("未衰减时沿用旧意图", o2["type"] == "social" and it.current()["formed_at"] == formed,
      f"{o2['type']} formed={it.current()['formed_at']==formed}")

print("[3] 意图满足闭环")
before = it.current()["strength"]
it.satisfy("speak", amount=0.5)
after = it.current()["strength"]
check("speak 满足 social 意图→强度降", after < before, f"{before:.3f}→{after:.3f}")
it.reset()
print("[4] 果蝇脑驱动（低唤醒冻结 / withdraw 趋避）")
import drive_client as dc
class FakeBrain:
    def __init__(self, axes, speak=0.5, withdraw=0.0, fresh=True, sleep=0.0):
        self._ax, self._spk, self._wd, self._fresh, self._slp = axes, speak, withdraw, fresh, sleep
    @property
    def fresh(self): return self._fresh
    @property
    def axes(self): return self._ax
    @property
    def speak(self): return self._spk
    @property
    def withdraw(self): return self._wd
    @property
    def sleep_pressure(self): return self._slp

orig = dc.latest_drive_state
dc.latest_drive_state = lambda: FakeBrain({"arousal":0.05,"valence":0.5,"tension":0.5,"satiety":0.5})
it.reset()
o = it.form(n_obs=1)
check("低唤醒→冻结意图", o["type"] == "restful" and "freeze" in o.get("why",""), f"{o['type']} {o.get('why')}")
dc.latest_drive_state = lambda: FakeBrain({"arousal":0.8,"valence":0.1,"tension":0.5,"satiety":0.3}, withdraw=0.95)
it.reset()
o = it.form(n_obs=1)
check("高趋避→avoidant 意图", o["type"] == "avoidant", f"{o['type']} {o['strength']}")
check("avoidant→wait 一致性>0", it.consistency("wait") > 0, str(round(it.consistency('wait'),3)))
# 高 sleep_pressure → restful（先重置驱力基线，避免上一段社交驱力残留污染）
for n in cg.DRIVE_NAMES: cg.drive_set(n, cg._DV_FALLBACK["base"][n])
dc.latest_drive_state = lambda: FakeBrain({"arousal":0.6,"valence":0.5,"tension":0.3,"satiety":0.5}, sleep=0.95)
it.reset()
o = it.form(n_obs=0)
check("高睡眠压力→restful 意图", o["type"] == "restful", f"{o['type']} {o['strength']}")
dc.latest_drive_state = orig
it.reset()

print("[5] evolution 真正接管决策")
import evolution as ev, arbiter as a
U = {"speak": 0.28, "ack": 0.20, "wait": 0.15}
r_no = ev.decide_action(U, intent_consistency=lambda a: 0.0)
cg.drive_set("social", 0.95); it.reset(); it.form(n_obs=0)
r_yes = ev.decide_action(U)
check("无意图时选 speak（效用最高）", r_no["action"] == "speak", r_no["action"])
check("有意图时 chosen_by 标注", "intent" in r_yes["chosen_by"] or r_yes["intent_bias"] > 0,
      f"{r_yes['chosen_by']} bias={r_yes['intent_bias']}")
check("意图一致性抬高总适应度", r_yes["score"] >= r_no["score"], f"{r_no['score']}→{r_yes['score']}")
r_off = ev.decide_action(U, intent_consistency=lambda a: 0.0)
check("无一致性时回落纯效用", r_off["intent_bias"] == 0.0)

print("[6] arbiter 接入（决策 reason 含意图信息）")
for n in cg.DRIVE_NAMES: cg.drive_set(n, cg._DV_FALLBACK["base"][n])
a._dc.latest_drive_state = lambda: type("F",(),{"fresh":False,"speaking":False,"withdraw":0.0,"speak":0.0,"recall_strength":0.0})()
cg._WM["last_proactive_ts"] = time.time()-4000
cg._WM["proactive_count_hour"]=0; cg._WM["proactive_hour_bucket"]=time.localtime().tm_hour
v = a.decide("idle", text="")
check("idle 决策不崩", v["action"] in ("speak","ack","silent"), v["action"])
r = a.utility_decide("idle")
check("明细含 chosen_by", "chosen_by" in r[3], str(list(r[3].keys())[-4:]))
check("明细含 intent", "intent" in r[3])

print("[7] 退出型意图的主动否决")
import drive_client as dc2
class VetoBrain:
    fresh=True
    axes={'arousal':0.7,'valence':0.5,'tension':0.3,'satiety':0.5}
    speak=0.9; withdraw=0.0; sleep_pressure=0.0
    @property
    def speaking(self): return False
    @property
    def recall_strength(self): return 0.0
_orig_dc = a._dc.latest_drive_state
for n in cg.DRIVE_NAMES: cg.drive_set(n,cg._DV_FALLBACK['base'][n])
cg.drive_set('rest',0.95)
a._dc.latest_drive_state=lambda:VetoBrain()
it.reset(); io=it.form(n_obs=0)
cg._WM['last_proactive_ts']=time.time()-4000
cg._WM['proactive_count_hour']=0;cg._WM['proactive_hour_bucket']=time.localtime().tm_hour
v=a.decide('idle',text='')
check("强休息意图否决策略", v["action"]=="silent" and "intent_veto" in v["reason"],
      f"{io['type']} {io['strength']}->{v['action']} {v['reason'][-28:]}")
a._abl_orig = a._abl
a._abl = lambda c: c=="intent"
v2=a.decide('idle',text='')
check("消融 intent 后否决失效", "intent_veto" not in v2["reason"], v2["reason"][-30:])
a._abl = a._abl_orig
a._dc.latest_drive_state=_orig_dc

it.reset()
print(f"\n结果: {PASS} 通过, {FAIL} 失败")
sys.exit(0 if FAIL==0 else 1)
