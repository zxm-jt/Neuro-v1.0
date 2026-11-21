import os
import io
import json
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))
import agent_bridge as ab


class FakeResp:
    """模拟 urllib 响应：可 with、可按行迭代（上游 SSE）。"""

    def __init__(self, lines):
        self._lines = [l.encode("utf-8") for l in lines]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def __iter__(self):
        return iter(self._lines)


def sse_lines(pieces, reasoning=False):
    out = []
    if reasoning:
        out.append("data: " + json.dumps({"choices": [{"delta": {"reasoning_content": "hmm"}}]}))
    for p in pieces:
        out.append("data: " + json.dumps({"choices": [{"delta": {"content": p}}]}))
    out.append("data: [DONE]")
    return out


def run(pieces, **kw):
    ab._open_upstream = lambda *a, **k: FakeResp(sse_lines(pieces, **kw))
    return list(ab.llm_stream({}, []))


print("=== 1) 普通两句，情绪必须在第一句完整之前 ===")
ev = run(["[happy] Hello the", "re, user. How a", "re you?"])
for e in ev:
    print("   ", e)
kinds = [k for k, _ in ev]
assert kinds.index("emo") < len(ev), "no emo"
# 找到第一个含句末标点的 txt 事件下标，情绪必须排在它前面
first_dot = next(i for i, (k, v) in enumerate(ev) if k == "txt" and "." in v)
assert kinds.index("emo") < first_dot, f"emo 晚于第一句: {ev}"
assert ev[0] == ("emo", "happy"), ev[0]
assert "".join(v for k, v in ev if k == "txt") == "Hello there, user. How are you?", ev
print("    OK  正文无标签、情绪先到、内容完整")

print("=== 2) 工具调用：不得转发任何正文 ===")
ev = run(["[[TOOL:", '{"op":"list_dir","args":{"path":"D:/"}}', "]]"])
print("   ", ev)
assert len(ev) == 1 and ev[0][0] == "tool", ev
assert json.loads(ev[0][1])["op"] == "list_dir"
print("    OK  只产出 tool 事件")

print("=== 3) 上游挂了 -> 兜底话术 + worried ===")
ab._open_upstream = lambda *a, **k: None
ev = list(ab.llm_stream({}, []))
print("   ", ev)
assert ev[0] == ("emo", "worried")
assert "[" not in ev[1][1] and "Hmm, my brain" in ev[1][1]
print("    OK")

print("=== 4) 只思考没正文 / 半个标签 ===")
ev = run(["I think [ha", "ppy] it's fine."], reasoning=True)
print("   ", ev)
assert "reasoning" not in "".join(v for k, v in ev if k == "txt")
assert "[ha" not in "".join(v for k, v in ev if k == "txt"), ev
print("    OK  reasoning 未转发，半个标签未漏出")

print("=== 5) chat_stream 工具分支（list_dir 是安全操作，会执行并回灌）===")
calls = []


def fake_stream(cfg, messages, retries=4, max_tokens_override=None):
    calls.append(messages[-1]["content"][:30])
    yield ("emo", "neutral")
    yield ("txt", "D:/ 下有：a、b")


ab.llm_stream = fake_stream
ev = list(ab.chat_stream({"messages": [{"role": "user", "content": "看看 D:/ 有什么"}]}))
print("   ", ev)
assert ev == [{"emotion": "neutral"}, {"emotion": "neutral"}], ev
# 被作废的两轮正文（第一轮 + 重问轮）都不得出现在任何事件里
txt_all = "".join((e.get("choices") or [{}])[0].get("delta", {}).get("content") or "" for e in ev)
assert txt_all.count("D:/ 下有：a、b") == 0, txt_all
print("    OK  动作意图轮次：没调工具的正文（含重问轮）一律扣下，不念谎话")

print("=== 6) chat_stream 命中工具（走执行+回灌，正文来自第二轮）===")
seq = [
    [("tool", '{"op":"list_dir","args":{"path":"D:/"}}')],
    [("emo", "happy"), ("txt", "Found it.")],
]
seen = []
it = iter(seq)


def _rec(cfg, messages, retries=4, max_tokens_override=None):
    seen.append(messages)
    return iter(next(it))


ab.llm_stream = _rec
ev = list(ab.chat_stream({"messages": [{"role": "user", "content": "看看 D:/ 有什么"}]}))
print("   ", ev[0].get("executed"), "|", [e.get("emotion") or list((e.get("choices") or [{}])[0].get("delta", {}).values()) for e in ev])
assert ev[0].get("executed") == "list_dir", ev[0]
assert (ev[0].get("result") or {}).get("ok") is True, ev[0]
assert ev[1] == {"emotion": "happy"}, ev[1]
assert ev[2] == {"choices": [{"delta": {"content": "Found it."}}]}, ev[2]
assert len(ev) == 3, ev
# 第二轮的请求里必须带上工具执行结果（说明工具真的跑了、且结果被回灌）
assert any("[[TOOL_RESULT" in m.get("content", "") for m in seen[-1]), seen[-1]
# 工具标记本身绝不能出现在转发给前端的正文里
assert all("[[TOOL" not in ((e.get("choices") or [{}])[0].get("delta", {}).get("content") or "") for e in ev), ev
# "executed" 事件里的 result 也不能把工具标记泄漏出去
assert "[[TOOL" not in json.dumps(ev[0], ensure_ascii=False), ev[0]
print("    OK  工具真的执行了、executed 事件下发了、结果回灌了、标记没有泄漏到正文")

print("=== 7) 破坏性操作：先口头确认并挂起 PENDING ===")
ab.PENDING["op"], ab.PENDING["args"] = None, None
seq2 = [
    [("tool", '{"op":"delete_path","args":{"path":"received_audio"}}')],
    [("emo", "worried"), ("txt", "Really delete it?")],
]
it2 = iter(seq2)
ab.llm_stream = lambda cfg, m, retries=4, max_tokens_override=None: iter(next(it2))
ev = list(ab.chat_stream({"messages": [{"role": "user", "content": "删掉 received_audio"}]}))
print("   ", ev, "PENDING =", ab.PENDING["op"])
assert ab.PENDING["op"] == "delete_path", ab.PENDING
assert ev == [{"pending": "delete_path"},
              {"emotion": "worried"},
              {"choices": [{"delta": {"content": "Really delete it?"}}]}], ev
# 确认话术里不能泄漏工具标记
assert all("[[TOOL" not in ((e.get("choices") or [{}])[0].get("delta", {}).get("content") or "") for e in ev), ev
print("    OK  没有真删，改为挂起等确认，pending 事件已下发")
ab.PENDING["op"], ab.PENDING["args"] = None, None

print("\nALL PASS")
