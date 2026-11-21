from __future__ import annotations

import asyncio
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(HERE, "..", "backend")
sys.path.insert(0, BACKEND)

import vision_manager as vm  # noqa: E402

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("  PASS " if cond else "  FAIL ") + name + (f"  [{detail}]" if detail else ""))


def make_jpeg(color=(0, 0, 0), size=(64, 64)):

    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="JPEG", quality=80)
    return buf.getvalue()


class StubAPI:
    """视觉 API 桩：记录调用次数，返回可控文本。"""

    def __init__(self, reply="An editor window with Python code"):
        self.calls = 0
        self.reply = reply

    def __call__(self, jpeg_bytes, question):
        self.calls += 1
        if question:
            return f"answer to: {question}"
        return self.reply


async def run():
    print("[1] 接口契约")
    mgr = vm.VisionManager()
    for attr in ("active", "status", "start", "stop", "push_frame", "ask",
                 "observation_context", "observations", "clear_observations",
                 "mark_start"):
        check(f"有 {attr}", hasattr(mgr, attr))
    st = mgr.status()
    check("status 含 frames/has_key/model",
          all(k in st for k in ("frames", "has_key", "model")), str(sorted(st)))

    print("[2] 未配置 key → 不启动、不调用")
    os.environ.pop("ZHIPUAI_API_KEY", None)
    os.environ.pop("NEURO_VISION_FREE_KEY", None)
    orig_cfg = vm._cfg_free
    vm._cfg_free = lambda k, d=None: (
        True if k == "enabled" else ("" if k == "api_key" else orig_cfg(k, d)))
    try:
        ok = await mgr.start()
        check("缺 key 时 start() 返回 False", ok is False)
        sent = await mgr.push_frame(make_jpeg((255, 255, 255)))
        check("缺 key 时 push_frame 不发", sent is False)
    finally:
        vm._cfg_free = orig_cfg

    print("[3] 变化检测 + 最小间隔 + 去重（全部离线）")
    fake = {
        "enabled": True, "api_key": "test-key", "model": "glm-4v-flash",
        "api_url": "http://127.0.0.1:9/v1", "auto_push_frames": True,
        "fps": 1.0, "change_threshold": 0.06, "min_interval_s": 6,
        "max_observations": 3, "observation_dup_similarity": 0.82,
        "observation_dup_window_s": 90, "max_tokens": 64,
        "fallback": {},
    }
    vm._cfg_free = lambda k, d=None: fake.get(k, d)
    try:
        mgr2 = vm.VisionManager()
        os.environ["ZHIPUAI_API_KEY"] = "test-key"
        ok = await mgr2.start()
        check("配置齐全时 start() 成功", ok is True, f"active={mgr2.active}")

        stub = StubAPI()
        mgr2._call_vision_api = stub

        white = make_jpeg((255, 255, 255))
        black = make_jpeg((0, 0, 0))

        # 第一帧：基准为空 → 必须送出去
        sent1 = await mgr2.push_frame(white)
        await asyncio.sleep(0.15)
        check("首帧被送去理解", sent1 is True and stub.calls == 1,
              f"sent={sent1} calls={stub.calls}")

        sent2 = await mgr2.push_frame(white)
        await asyncio.sleep(0.1)
        check("相同画面被变化检测拦下",
              sent2 is False and stub.calls == 1, f"calls={stub.calls}")

        sent3 = await mgr2.push_frame(black)
        await asyncio.sleep(0.1)
        check("间隔未到 → 即便画面变了也不调用",
              sent3 is False and stub.calls == 1, f"calls={stub.calls}")

        mgr2._last_call_at -= 10
        sent4 = await mgr2.push_frame(make_jpeg((0, 0, 255)))
        await asyncio.sleep(0.15)
        check("间隔到了 → 显著变化被送去理解",
              sent4 is True and stub.calls == 2, f"calls={stub.calls}")

        mgr2.clear_observations()
        mgr2._add_observation(stub.reply, "proactive")
        mgr2._add_observation(stub.reply, "proactive")
        mgr2._add_observation(stub.reply, "proactive")
        check("相似观察被合并计数",
              len(mgr2.observations) == 1 and mgr2.observations[0].count == 3,
              f"n={len(mgr2.observations)}")

        # 上限：塞 5 条不同的观察 → 只留最近 3 条
        mgr2.clear_observations()
        for i in range(5):
            mgr2._add_observation(f"distinct observation number {i} about window {i}",
                                  "proactive")
        check("观察条数受 max_observations 限制",
              len(mgr2.observations) == 3, f"n={len(mgr2.observations)}")

        print("[4] nothing-notable 过滤")
        mgr2.clear_observations()
        stub2 = StubAPI(reply="nothing notable.")
        mgr2._call_vision_api = stub2
        await mgr2._observe(white)
        check("模型说 nothing notable → 不入观察", len(mgr2.observations) == 0,
              f"n={len(mgr2.observations)}")

        print("[5] 观察上下文格式（vision_persona / 前端依赖）")
        mgr2.clear_observations()
        mgr2._add_observation("A browser is showing a news article", "proactive")
        ctx = mgr2.observation_context()
        check("上下文含固定引导语",
              "What you can see on user's screen right now" in ctx)
        check("上下文含时间与来源标记",
              "s ago, proactive]" in ctx, ctx.strip()[:80])
        check("无观察时上下文为空", vm.VisionManager().observation_context() == "")

        print("[6] ask() 走桩 + 超时安全")
        mgr2._latest_jpeg = white
        ans = await mgr2.ask("what number is shown?", timeout=3)
        check("ask 返回桩回答", ans.startswith("answer to:"), ans)
        check("ask 的观察记为 asked",
              any(o.source == "asked" for o in mgr2.observations))

        await mgr2.stop()
        check("stop() 后 active=False", mgr2.active is False)
    finally:
        vm._cfg_free = orig_cfg
        os.environ.pop("ZHIPUAI_API_KEY", None)

    print("[7] config.json 结构校验")
    cfg_path = os.path.join(HERE, "..", "config.json")
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    v = cfg.get("vision") or {}
    check("config vision.moss 已删除", "moss" not in v)
    free = v.get("free") or {}
    for k in ("enabled", "api_url", "api_key", "model", "max_tokens", "fps",
              "change_threshold", "min_interval_s", "max_observations",
              "observation_dup_similarity", "observation_dup_window_s",
              "auto_push_frames"):
        check(f"config vision.free.{k} 存在", k in free)
    _key = str(free.get("api_key", ""))
    _placeholder = any(t in _key.lower() for t in
                       ("placeholder", "your_api_key", "test-key", "changeme", "sk-xxxx"))
    check("config 未写死占位密钥", not _placeholder,
          "(空，待填写)" if not _key else "已配置真实 key(len=%d)" % len(_key))
    check("默认模型为 glm-4v-flash", free.get("model") == "glm-4v-flash",
          repr(free.get("model")))
    check("fallback 结构存在", isinstance(free.get("fallback"), dict))


if __name__ == "__main__":
    asyncio.run(run())
    print()
    print(f"PASS {len(PASS)}  FAIL {len(FAIL)}")
    if FAIL:
        print("FAILED:", ", ".join(FAIL))
        sys.exit(1)
    sys.exit(0)
