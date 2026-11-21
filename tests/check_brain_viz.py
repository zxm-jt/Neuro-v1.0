# -*- coding: utf-8 -*-
"""check_brain_viz.py — 实时放电图的数据契约（不需要界面）。
用法：python tests/check_brain_viz.py"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("BRAIN_VIZ_TEST_PORT", "6109"))
BASE = f"http://127.0.0.1:{PORT}"
fails = 0


def ck(name, cond, extra=""):
    global fails
    if cond:
        print(f"  PASS {name}")
    else:
        fails += 1
        print(f"  FAIL {name}  {extra}")


def get(path, timeout=2.0):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def wait_up(deadline=20.0):
    t0 = time.time()
    while time.time() - t0 < deadline:
        try:
            get("/health", timeout=1.5)
            return True
        except Exception:
            time.sleep(0.3)
    return False


p = subprocess.Popen([sys.executable, "-m", "flybridge.brain_server", "--port", str(PORT)],
                     cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    if not wait_up():
        print("  FAIL 桥没起来")
        sys.exit(1)

    d = get("/viz")
    t0 = time.time()
    while not (d.get("frames") or []) and time.time() - t0 < 20:
        time.sleep(0.3)
        d = get("/viz")
    ck("n=256", d.get("n") == 256, d.get("n"))
    frames = d.get("frames") or []
    ck("返回了帧", len(frames) > 0, len(frames))
    ck("每帧 32 字节", all(len(base64.b64decode(f["d"])) == 32 for f in frames))
    ck("帧号递增", [f["f"] for f in frames] == sorted(f["f"] for f in frames))
    any_bit = any(any(base64.b64decode(f["d"])) for f in frames)
    # 全新状态下的静息脑放电稀疏：给一段预热窗口，避免"刚起来还没放过电"被误判
    t_warm = time.time()
    while not any_bit and time.time() - t_warm < 30:
        time.sleep(0.5)
        frames = (get("/viz").get("frames") or [])
        any_bit = any(any(base64.b64decode(f["d"])) for f in frames)
    ck("不是全 0（真的在放电）", any_bit)

    last = frames[-1]["f"] if frames else 0
    time.sleep(0.5)
    d2 = get(f"/viz?since={last}")
    f2 = d2.get("frames") or []
    ck("增量请求有更新帧", bool(f2) and f2[-1]["f"] > last, (last, f2[-1]["f"] if f2 else None))
    ck("只发新帧", all(f["f"] > last for f in f2))

    m = get("/viz3d/meta")
    ck("3D n_total=166700", m.get("n_total") == 166700, m.get("n_total"))
    ck("3D 采样 16384", m.get("n_sample") == 16384, m.get("n_sample"))
    ck("3D 每帧 2048 字节", m.get("bits_per_frame") == 2048, m.get("bits_per_frame"))
    ck("3D 27 个 superclass", len(m.get("superclasses") or []) == 27)

    blob = urllib.request.urlopen(BASE + "/viz3d/points", timeout=10).read()
    ck("3D 点云长度正确（36 + n*12 + n）", len(blob) == 36 + 16384 * 12 + 16384, len(blob))
    ck("3D 点云 magic=NV3D", blob[:4] == b"NV3D", blob[:4])

    s3 = get("/viz3d/spikes")
    f3 = s3.get("frames") or []
    ck("3D 有放电帧", bool(f3))
    ck("3D 帧 2048 字节", all(len(base64.b64decode(x["d"])) == 2048 for x in f3))
    ck("3D 位图非全 0", any(any(base64.b64decode(x["d"])) for x in f3))
finally:
    p.terminate()
    try:
        p.wait(timeout=5)
    except Exception:
        p.kill()

print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(0 if fails == 0 else 1)
