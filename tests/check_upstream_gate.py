# -*- coding: utf-8 -*-
"""tests/check_upstream_gate.py —— 上游单飞闸不能死锁。"""
import importlib.util
import os
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

spec = importlib.util.spec_from_file_location("ab", os.path.join(ROOT, "backend", "agent_bridge.py"))
ab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ab)

PASS = FAIL = 0


def ck(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}  {detail}")


def call_with_timeout(fn, timeout=6.0, *args):

    box = {}

    def _run():
        try:
            box['r'] = fn(*args)
        except Exception as e:
            box['e'] = e

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        return False, None
    return True, box.get('r')


print("[1] _paced_slot 不能死锁（这是修复的核心）")
ok, res = call_with_timeout(ab._paced_slot, 6.0, 8.0)
ck("_paced_slot 在 6 秒内返回", ok, "死锁（线程未结束）")
if ok:
    ck("拿到名额", isinstance(res, tuple) and res[0] is True, str(res))
    ab._paced_release()

print("\n[2] 连续 5 次拿名额-释放，都不能卡")
all_ok = True
for i in range(5):
    ok, res = call_with_timeout(ab._paced_slot, 4.0, 4.0)
    if not ok:
        all_ok = False
        break
    if isinstance(res, tuple) and res[0]:
        ab._paced_release()
ck("连续 5 次无死锁", all_ok)

print("\n[3] 冷却期内应立刻返回 False（不占名额）")
ab._cool_down(3.0)
ok, res = call_with_timeout(ab._paced_slot, 4.0, 2.0)
ck("冷却检查返回（不死锁）", ok, "死锁")
if ok:
    ck("冷却中 → 拿不到名额", res[0] is False, str(res))
    ck("原因写明是冷却", "冷却" in res[1], str(res))
ab._COOL_UNTIL = 0.0

print("\n[4] 多线程并发抢名额 → 不能死锁，且名额不会重复发放")
results = []
lock = threading.Lock()


def worker():
    ok2, res = call_with_timeout(ab._paced_slot, 8.0, 5.0)
    with lock:
        results.append((ok2, res))


threads = [threading.Thread(target=worker, daemon=True) for _ in range(4)]
for t in threads:
    t.start()
for t in threads:
    t.join(10)
alive = [t for t in threads if t.is_alive()]
ck("所有线程都结束（无死锁）", not alive, f"{len(alive)} 个还活着")
granted = sum(1 for ok2, res in results if ok2 and isinstance(res, tuple) and res[0])
ck("有线程拿到名额", granted >= 1, f"granted={granted}")
ab._paced_release()

print(f"\n结果：{PASS} PASS / {FAIL} FAIL")
sys.exit(0 if FAIL == 0 else 1)
