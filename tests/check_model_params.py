import json
import io
import re
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = os.path.join(ROOT, "2D", "Hiyori.model3.json")
CODE = os.path.join(ROOT, "js", "model-interaction.js")


def main():
    if not os.path.isfile(MODEL):
        print("model not found:", MODEL)
        return 1
    m = json.load(io.open(MODEL, encoding="utf-8"))

    motion_groups = {}
    refs = m.get("FileReferences") or {}
    motions = refs.get("Motions") or {}
    if isinstance(motions, dict):
        motion_groups = motions
    elif isinstance(motions, list):
        #兼容 Cubism3：[{Group:.., File:..}]
        for it in motions:
            if isinstance(it, dict) and it.get("Group"):
                motion_groups.setdefault(it["Group"], []).append(it)

    group_ids = set(motion_groups.keys())
    for g in m.get("Groups") or []:
        for i in (g.get("Ids") or []):
            group_ids.add(i)

    src = io.open(CODE, encoding="utf-8").read()
    params = set(re.findall(r"_setPair\('([^']+)'", src))
    params |= set(re.findall(r"_setEmotionParam\('([^']+)'", src))
    motions = set(re.findall(r"motion\('([^']+)'", src))

    print("模型里注册的动作组共 %d 个: %s"
          % (len(group_ids), ', '.join(sorted(group_ids))))
    print("Groups 里声明的参数 id: %s"
          % (', '.join(sorted(i for i in group_ids
                            if i and i.startswith('Param'))) or '（无）'))
    print("提示: 完整参数清单在 .moc3 二进制里，JSON 读不到，"
          "参数名只能靠运行时日志验证。")

    print("\n=== 参数核对 ===")
    ok, bad = [], []
    for p in sorted(params):
        (ok if p in group_ids else bad).append(p)
    for p in ok:
        print("  OK   %s" % p)
    for p in bad:
        print("  缺失 %s   <-- 代码在用，但模型里没有！setParameterValueById 会【静默无效】" % p)

    print("\n=== 动作组核对 ===")
    okm, badm = [], []
    for g in sorted(motions):
        (okm if g in group_ids else badm).append(g)
    for g in okm:
        print("  OK   %s" % g)
    for g in badm:
        print("  缺失 %s   <-- 模型里没有这个动作组，motion() 直接 return false" % g)

    print("\n模型里可用的动作组（供参考）:")
    for g in sorted(motion_groups.keys()):
        print("  -", g)

    print("\n模型里有、但代码没用的表情相关参数（可能漏配）:")
    for i in sorted(x for x in group_ids if x and ("Brow" in x or "Eye" in x or "Mouth" in x or "Cheek" in x)):
        if i not in params:
            print("  -", i)

    return 0


if __name__ == "__main__":
    sys.exit(main())
