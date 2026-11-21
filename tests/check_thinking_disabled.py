# -*- coding: utf-8 -*-
"""tests/check_thinking_disabled.py —— thinking 开关必须【显式】发 disabled。"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = io.open(os.path.join(ROOT, "backend", "agent_bridge.py"), encoding="utf-8").read()

start = SRC.index("max_tokens = int(max_tokens_override")
end = SRC.index("data = json.dumps(payload)")
seg = SRC[start:end]

passed = failed = 0


def ck(name, cond):
    global passed, failed
    if cond:
        print("  OK   " + name); passed += 1
    else:
        print("  FAIL " + name); failed += 1


print("\n[1] disabled 分支必须显式发送 thinking:{type:disabled}")
ck("存在 payload[\"thinking\"] = {\"type\": \"disabled\"}",
   'payload["thinking"] = {"type": "disabled"}' in seg)
ck("disabled 的 thinking 赋值先于 temperature 赋值",
   seg.index('{"type": "disabled"}') < seg.index('payload["temperature"]'))

print("\n[2] enabled 分支必须发送 thinking:{type:enabled} + reasoning_effort")
ck("存在 payload[\"thinking\"] = {\"type\": \"enabled\"}",
   'payload["thinking"] = {"type": "enabled"}' in seg)
ck("存在 payload[\"reasoning_effort\"]",
   'payload["reasoning_effort"]' in seg)
ck("_thinking_on 判据存在（disabled/off/none/空 均视为关）",
   '_thinking_on' in seg and '"disabled", "off", "none", ""' in seg)

print("\n[3] 防回归：不得再出现「只在 thinking_on 时发、disabled 时什么都不发」的旧写法")
if_idx = seg.index("if _thinking_on:")
else_idx = seg.index("else:", if_idx)
enabled_blk = seg[if_idx:else_idx]
else_blk = seg[else_idx:]
ck("enabled 块里有 thinking 赋值", 'payload["thinking"]' in enabled_blk)
ck("disabled(else) 块里也有 thinking 赋值", 'payload["thinking"]' in else_blk)

print("\n结果：%d PASS / %d FAIL" % (passed, failed))
sys.exit(0 if failed == 0 else 1)
