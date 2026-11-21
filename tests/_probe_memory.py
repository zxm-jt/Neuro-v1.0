"""临时探针：验证记忆的读取与检索选择（用完即删）。"""
import sys, os, json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))
os.chdir(os.path.join(ROOT, "backend"))

import memory_system as m

print("== 环境 ==")
try:
    print("  _embed_enabled():", m._embed_enabled())
except Exception as e:
    print("  embed_enabled ERR", e)
cfg = m._cfg_memory()
print("  cfg:", json.dumps({k: cfg.get(k) for k in
      ("retrieval_threshold", "force_threshold", "retrieval_threshold_tfidf", "max_inject")},
      ensure_ascii=False))

frags = m.load_memories()
print("  片段总数:", len(frags))
vecs = sum(1 for f in frags if isinstance(f.get("vec"), list) and f["vec"])
print("  带向量:", vecs)

print("\n== 常驻层 ==")
rp = m.resident_prompt()
print("  长度:", len(rp), "| 首行:", rp.split("\n")[0][:80])

print("\n== 强制检索（force=True，跳过门控） ==")
for q in ("Visual Studio C# debugging", "TTS port conflict", "你还记得我上次在做什么吗"):
    hits = m.retrieve(q, force=True)
    print(f"  [{q}] -> {len(hits)} 条")
    for f, s in hits:
        print(f"      {s:.3f}  {str(f.get('text'))[:70]}")

print("\n== 普通检索（force=False，走阈值门控） ==")
for q in ("TTS port conflict", "Visual Studio C#", "what did you eat today"):
    hits = m.retrieve(q, force=False)
    print(f"  [{q}] -> {len(hits)} 条")
    for f, s in hits:
        print(f"      {s:.3f}  {str(f.get('text'))[:70]}")

print("\n== recall_context（真实注入文本） ==")
for q in ("TTS port conflict", "what did you eat today"):
    ctx = m.recall_context(q, force=False)
    print(f"  [{q}] -> {repr(ctx)[:260]}")

print("\n== 强制回想的注入文本 ==")
print(repr(m.recall_context("你还记得我上次在做什么吗", force=True))[:400])
