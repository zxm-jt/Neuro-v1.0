from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PORT = int(os.environ.get("BRIDGE_TEST_PORT", "6107"))
BASE = f"http://127.0.0.1:{PORT}"


def get(path: str, timeout: float = 5.0):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def post(path: str, obj: dict, timeout: float = 5.0):
    data = json.dumps(obj).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def wait_up(deadline_s: float = 20.0) -> bool:
    t0 = time.time()
    while time.time() - t0 < deadline_s:
        try:
            get("/health", timeout=2.0)
            return True
        except Exception:
            time.sleep(0.3)
    return False


def spawn(tag: str):
    out = HERE / "state" / f"selftest_{tag}.out"
    err = HERE / "state" / f"selftest_{tag}.err"
    out.parent.mkdir(parents=True, exist_ok=True)
    f = open(out, "wb")
    fe = open(err, "wb")
    p = subprocess.Popen([sys.executable, "-m", "flybridge.brain_server",
                          "--port", str(PORT), "--hz", "25"],
                         cwd=str(ROOT), stdout=f, stderr=fe)
    return p


def main() -> int:
    fails = []
    print("[1] boot")
    p = spawn("a")
    if not wait_up():
        print("  FAIL: server did not come up")
        p.terminate()
        return 1
    time.sleep(2.0)
    h = get("/health")
    print("  ok, frame", h["frame"], "fps", h["fps"])
    if h["frame"] < 10:
        fails.append("frame did not advance")

    print("[2] /out shape")
    o = get("/out")
    for k in ("actions", "axes", "emotion", "pools", "features", "health"):
        if k not in o:
            fails.append(f"missing {k}")
    if not (-1.01 <= o["axes"]["valence"] <= 1.01):
        fails.append("valence out of range")
    if not (0.0 <= o["actions"]["speak"] <= 1.0):
        fails.append("speak out of range")
    if not o["emotion"].get("label") and not o["emotion"].get("n_clusters"):
        fails.append("emotion block is empty (no cluster, no label)")
    print("  emotion =", o["emotion"].get("label"), "clusters =", o["emotion"].get("n_clusters"),
          "speak =", round(o["actions"]["speak"], 3))

    print("[3] sensory injection reaches the connectome")
    before = get("/out")["pools"]
    vision = [0.9] * 300
    post("/in", {"v": 1, "senses": {"vision": vision, "audio": 0.9,
                                    "touch": [["click", 0.9]]},
                 "intero": {"outcome": "praise"}})
    time.sleep(0.6)
    after = get("/out")["pools"]
    moved = {k: round(after[k] - before.get(k, 0.0), 5) for k in after}
    changed = any(abs(v) > 1e-5 for v in moved.values())
    print("  pool delta:", {k: v for k, v in moved.items() if abs(v) > 1e-5} or "(none)")
    if not changed:
        fails.append("injection had no measurable effect on any pool")

    print("[4] /reward updates the head and teaches the cluster a word")
    u0 = get("/state")["head_updates"]
    post("/reward", {"r": 1.0, "why": "selftest", "expr": "shy"})
    u1 = get("/state")["head_updates"]
    o2 = get("/out")
    print(f"  head_updates {u0} -> {u1}; label={o2['emotion'].get('label')!r} "
          f"labels_learned={o2['emotion'].get('labels_learned')}")
    if u1 <= u0:
        fails.append("reward did not update head")
    if not o2["emotion"].get("labels_learned"):
        fails.append("reward did not attach an expression to a cluster")

    print("[4b] associative memory accumulated and recalls")
    o3 = get("/out")
    print(f"  recall.strength = {o3['recall']['strength']}, "
          f"clusters = {o3['emotion']['n_clusters']}")
    if float(o3["recall"]["strength"]) <= 0.0:
        fails.append("associative memory has no recall signal")
    if int(o3["emotion"]["n_clusters"]) < 1:
        fails.append("no affect cluster formed")

    print("[5] restart resumes from autosave")
    frame_before = get("/health")["frame"]
    time.sleep(13.0)
    saved = get("/health")["frame"]
    p.kill()
    p.wait(timeout=10)
    p2 = spawn("b")
    if not wait_up():
        fails.append("restart failed")
    else:
        time.sleep(2.0)
        resumed = get("/health")["frame"]
        print(f"  frame at save≈{saved}, after restart={resumed} (before kill {frame_before})")
        if resumed < 10:
            fails.append("restart did not restore state")
    p2.terminate()
    try:
        p2.wait(timeout=10)
    except Exception:
        p2.kill()

    print()
    if fails:
        print("FAILED:", "; ".join(fails))
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
