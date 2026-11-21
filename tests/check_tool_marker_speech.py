import importlib.util
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
sys.path.insert(0, os.path.join(_ROOT, "backend"))

spec = importlib.util.spec_from_file_location("agent_bridge", os.path.join(_ROOT, "backend", "agent_bridge.py"))
ab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ab)


class FakeResp:
    """模拟上游 SSE 流：把内容分片成多个 data: 行。"""
    def __init__(self, content_chunks):
        self._lines = []
        for c in content_chunks:
            payload = json.dumps({"choices": [{"delta": {"content": c}}]})
            self._lines.append(("data: " + payload).encode("utf-8"))
        self._lines.append(b"data: [DONE]")
        self.i = 0

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def __iter__(self):
        return iter(self._lines)


def run(content_chunks):
    ab._open_upstream = lambda *a, **k: FakeResp(content_chunks)
    stats = {"content": 0, "reasoning": 0}
    out = []
    for kind, val in ab._llm_stream_once({}, [], 0, None, stats):
        out.append((kind, val))
    return out


def speech(out):
    return "".join(v for k, v in out if k == "txt")


def has_tool(out):
    return [json.loads(v) for k, v in out if k == "tool"]


PASS = 0
FAIL = 0


def check(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  PASS  " + name)
    else:
        FAIL += 1
        print("  FAIL  " + name)


o1 = run(['Sure, I can open D:/ for you. [[open_path {"path":"D:/"', '}]]'])
check("S1 前缀被念出", speech(o1) == "Sure, I can open D:/ for you.")
check("S1 台词里没有 [[", not any("[[" in v for k, v in o1 if k == "txt"))
check("S1 识别为工具", len(has_tool(o1)) == 1 and has_tool(o1)[0]["op"] == "open_path")

o2 = run(['Let me do [[garbage_op {"x":1', '}]] that for you.'])
check("S2 命令块被删", "[[" not in speech(o2))
check("S2 不当作工具", len(has_tool(o2)) == 0)
check("S2 后半句保留", "that for you." in speech(o2))

o3 = run(["I love cats and dogs, user."])
check("S3 普通文本原样", speech(o3) == "I love cats and dogs, user.")
check("S3 无工具事件", len(has_tool(o3)) == 0)

o4 = run(['[[TOOL:{"op":"open_path","args":{"path":"D:/"}}]]'])
check("S4 纯命令无台词", speech(o4) == "")
check("S4 识别为工具", len(has_tool(o4)) == 1)

check("strip 小写变体", ab.strip_tool_markers('A. [[open_path {"path":"D:/"}]]') == "A.")
check("strip 嵌套 TOOL", ab.strip_tool_markers('B. [[TOOL:{"op":"x","args":{"p":"D:/"}}]] C.') == "B. C.")
check("strip 正常文本不变", ab.strip_tool_markers("plain text") == "plain text")

print("\n结果：%d PASS / %d FAIL" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
