"""临时探针：拆开检索门控，看普通轮为什么 0 命中（用完即删）。"""
import sys, os, json, math, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))
os.chdir(os.path.join(ROOT, "backend"))

import memory_system as m

cfg = m._cfg_memory()
th = float(cfg.get("retrieval_threshold", 0.45))
half_life = float(cfg.get("half_life_days", 3.0))
frags = m.load_memories()


def cos(a, b):
    if not a or not b:
        return 0.0
    n = min(len(a), len(b))
    dot = sum(a[i] * b[i] for i in range(n))
    na = math.sqrt(sum(x * x for x in a[:n]))
    nb = math.sqrt(sum(x * x for x in b[:n]))
    return dot / (na * nb) if na and nb else 0.0


def recency(f):
    try:
        ts = f.get("ts") or f.get("timestamp") or f.get("created_at")
        if isinstance(ts, str):
            t0 = time.mktime(time.strptime(ts[:19], "%Y-%m-%d %H:%M:%S"))
        else:
            t0 = float(ts)
        age_days = max(0.0, (time.time() - t0) / 86400.0)
        return 0.5 ** (age_days / half_life)
    except Exception:
        return 0.55


qs = ["TTS port conflict", "Visual Studio C#", "what did you eat today"]
for q in qs:
    uv = (m._embed_batch([q]) or [None])[0]
    print("=" * 20, q, "| uvec:", 'ok' if uv else 'MISSING')
    rows = []
    for f in frags:
        c = cos(uv, f.get("vec")) if uv else 0.0
        r = recency(f)
        gated = c * (0.55 + 0.45 * r)
        rows.append((gated, c, r, str(f.get("text"))[:56]))
    rows.sort(reverse=True)
    for g, c, r, t in rows[:3]:
        print(f"   cosine={c:.3f} recency={r:.3f} gated={g:.3f} {'PASS' if g >= th else 'drop'}  {t}")
