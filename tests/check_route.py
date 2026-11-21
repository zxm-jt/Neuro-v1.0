"""模拟 neuro_server 的 _sse_gen，检查真正下发到前端的 SSE 文本能否被 voice-chat.js 解析。"""
import os
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))
import agent_bridge as ab

PIECES = ["Sure! ", "Give me a sec", "ond, user."]


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        for p in PIECES:
            time.sleep(0.2)
            b = ("data: " + json.dumps({"choices": [{"delta": {"content": p}}]}) + "\n\n").encode()
            self.wfile.write(b"%X\r\n" % len(b) + b + b"\r\n")
            self.wfile.flush()
        b = b"data: [DONE]\n\n"
        self.wfile.write(b"%X\r\n" % len(b) + b + b"\r\n")
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def log_message(self, *a):
        pass


srv = HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
ab._open_upstream.__globals__  # noqa
orig = ab._open_upstream


def patched(cfg, messages, stream, retries=4, max_tokens_override=None):
    cfg = dict(cfg)
    cfg["llm"] = dict(cfg.get("llm") or {})
    cfg["llm"]["upstream_url"] = f"http://127.0.0.1:{srv.server_address[1]}/v1"
    return orig(cfg, messages, stream, retries,
                max_tokens_override=max_tokens_override)


ab._open_upstream = patched

messages = [{"role": "user", "content": "hi"}]
body = {"messages": messages, "stream": True}
buf = []


def gen():
    for ev in ab.chat_stream(body):
        c = ((ev.get("choices") or [{}])[0].get("delta") or {}).get("content")
        if c:
            buf.append(c)
        yield ab.sse_event(ev)
    yield "data: [DONE]\n\n"


raw = "".join(gen())
print("---- 实际下发的 SSE ----")
print(raw.replace("\n\n", "\n"))

full, emo, sse_buf = "", None, ""
lines = raw.split("\n")
sse_buf = lines.pop()
assert sse_buf == "", repr(sse_buf)
for line in lines:
    if not line.startswith("data: "):
        continue
    if "[DONE]" in line:
        continue
    data = json.loads(line[6:])
    if data.get("emotion"):
        emo = data["emotion"]
        continue
    c = data.get("choices", [{}])[0].get("delta", {}).get("content")
    if c:
        full += c
print("解析结果: emotion =", emo, "| fullResponse =", repr(full))
assert full == "Sure! Give me a second, user.", repr(full)
assert emo is not None, "情绪事件没下发"
assert "[" not in full
print("\nROUTE PASS")
srv.shutdown()
