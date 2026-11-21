# -*- coding: utf-8 -*-
"""check_chat_stream.py —— 验证 C10：对话流广播（SSE）的管道。
用法："""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

import neuro_server as ns  # noqa: E402

fails = 0


def check(name, cond, extra=""):
    global fails
    if cond:
        print(f"  PASS {name}")
    else:
        fails += 1
        print(f"  FAIL {name}  {extra}")


async def main_async():
    print("[1] _chat_publish 把行送到订阅者队列")
    q = asyncio.Queue(maxsize=10)
    ns._CHAT_SUBS.add(q)
    ns._CHAT_LOOP = asyncio.get_running_loop()
    try:
        ns._chat_publish("[00:00:00] user: hello")
        try:
            got = await asyncio.wait_for(q.get(), timeout=2.0)
        except asyncio.TimeoutError:
            got = None
        check("订阅者收到广播", got == "[00:00:00] user: hello", repr(got))
    finally:
        ns._CHAT_SUBS.discard(q)

    print("[2] 没有事件循环时不该崩（后端启动早期/线程里调用）")
    ns._CHAT_LOOP = None
    try:
        ns._chat_publish("no-loop")
        check("无循环调用不抛异常", True)
    except Exception as e:  # noqa: BLE001
        check("无循环调用不抛异常", False, repr(e))

    print("[3] 退订后不再收到")
    q2 = asyncio.Queue(maxsize=10)
    ns._CHAT_LOOP = asyncio.get_running_loop()
    ns._CHAT_SUBS.discard(q2)
    ns._chat_publish("after-unsub")
    check("退订后队列为空", q2.empty())


def main_sync():
    print("[4] _read_chat_tail 能读到文件尾部")
    tail = ns._read_chat_tail(3)
    check("返回列表", isinstance(tail, list), type(tail).__name__)
    check("不超过 N 行", len(tail) <= 3, str(len(tail)))
    check("tail=0 返回空", ns._read_chat_tail(0) == [])


if __name__ == "__main__":
    main_sync()
    asyncio.run(main_async())
    print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
    sys.exit(0 if fails == 0 else 1)
