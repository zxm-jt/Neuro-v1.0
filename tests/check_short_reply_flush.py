# -*- coding: utf-8 -*-
"""check_short_reply_flush.py —— 短回复不许被吞

【为什么需要这条测试】
流式路径为了先看清开头是不是 SILENT_TURN，会把正文攒在 _head_buf 里，
攒够 11 个字符才转发。流结束时如果没攒够，这段文本曾被整个丢掉 ——
"I hear you."（10 字）或纯表情 "[blush]"（7 字）一个字都到不了前端：
不出声、不显示字幕，用户看到的就是"她好像没回"。

同时补了前端兜底：本轮若没有任何文字进 TTS，就没有音频去驱动字幕，
必须把正文直接摆上屏。

这里做源码级断言（和本目录其它 check_* 一致），不依赖起服务。
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PASS = FAIL = 0


def ck(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}  {detail}")


srv = io.open(os.path.join(ROOT, "backend", "neuro_server.py"), encoding="utf-8").read()

print("[1] 后端：流结束前补发没攒够 11 字的正文")
ck("有短回复兜底块", "【短回复兜底】" in srv)
ck("兜底判断用 not _head_done",
   bool(re.search(r"if not _head_done and _head_buf\.strip\(\):", srv)))
# 关键顺序：补发必须发生在 [DONE] 之前，否则前端已经收摊了
i_flush = srv.find("【短回复兜底】")
i_done = srv.find('yield "data: [DONE]', i_flush)
ck("补发在 [DONE] 之前", i_flush > 0 and i_done > i_flush, f"{i_flush} / {i_done}")
ck("补发时把内容真的写进 buf（否则会话历史会漏这一句）",
   bool(re.search(r"buf\.append\(_head_buf\)", srv)))
ck("真该静默的仍静默（SILENT_TURN 不走补发）",
   bool(re.search(r"startswith\(\"SILENT_TURN\"\)", srv[i_flush:i_flush + 600])))

print("\n[2] 后端：11 字门槛本身还在（别为了修短句把 SILENT_TURN 检测废了）")
ck("仍保留 len(_head_buf.strip()) < 11 的先攒后发",
   "if len(_head_buf.strip()) < 11:" in srv)

print("\n[3] 前端：本轮没进 TTS 也要把正文显示出来")
vc_path = os.path.join(ROOT, "js", "voice-chat.js")
vc = io.open(vc_path, encoding="utf-8").read()
ck("记了 TTS 队列基线 _seqBefore", "const _seqBefore = this.ttsProcessor._ttsSeq || 0;" in vc)
ck("有「无音频也要有字」兜底", "【无音频也要有字】" in vc)
ck("兜底在 finalizeStreamingText 之后",
   vc.find("【无音频也要有字】") > vc.find("this.ttsProcessor.finalizeStreamingText();"))
ck("兜底会剥掉表情标签再上屏", ".replace(/[\\[\u3010]" in vc)
ck("没进 TTS 才兜底（有音频时不抢字幕）",
   "if (!_queued && _vis) this.showSubtitle(_vis, 8000);" in vc)

print(f"\n结果：{PASS} PASS / {FAIL} FAIL")
sys.exit(0 if FAIL == 0 else 1)
