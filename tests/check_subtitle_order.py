# -*- coding: utf-8 -*-
"""
check_subtitle_order.py —— 锁住"她的字幕不能跑到我说的话上面"

【回归背景】
用户报：聊天房面板里，她的实时逐字字幕行（无 [时间] neuro: 前缀、末尾带蓝色 ▍）
出现在【用户后来那条消息的上方】。根因是打字机游标只认"下一条未播的 neuro 行"，
不认轮次 —— 新一段语音会把内容灌进上一轮遗留的行。

【断言】
1. 存在 __isUserLine()：同时认 cmd: 与 user: 两种用户前缀
   （原版后端写 cmd:，开源版写 user:，只认一种会让护栏恒为 -1，等于没护栏）
2. __lineMode 带 lastUser 参数，且用户行之前的 neuro 行整行显示
3. __applyTtsProgress 计算 lastUserIdx
4. segToken 分支 base 有 lastUserIdx 下界
5. 兼容分支 base2 有 lastUserIdx 下界
6. 保持游标的条件带 __typer.idx >= lastUserIdx
7. live 定位与 liveInRow 前缀基准跳过旧轮
8. paint() 把 lastUserIdx 传给 __lineMode
9. __roomApply 不引用未定义的 cmd（v1.0 曾因机械改名留下 ReferenceError）
10. 用户消息 CSS 类名两套都认（.msg.cmd / .msg.user）
11. 后端 chat_log 截断保留首行 session 标记
"""
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PASS, FAIL = 0, 0


def ck(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  PASS  " + name)
    else:
        FAIL += 1
        d = detail if isinstance(detail, str) else "; ".join(str(x) for x in detail)
        print("  FAIL  " + name + ("   ← " + d if d else ""))


def read(p):
    with io.open(p, encoding="utf-8") as f:
        return f.read()


def main():
    cr = os.path.join(ROOT, "js", "chatroom.html")
    if not os.path.exists(cr):
        print("  SKIP  找不到 chatroom.html")
        return 0
    cr_s = read(cr)

    print("[1] 用户行识别助手")
    ck("有 __isUserLine()", "function __isUserLine" in cr_s)
    m = re.search(r"function __isUserLine\(s\)\{[^}]*\}", cr_s)
    ck("同时认 cmd: 与 user:",
       bool(m) and ("cmd" in m.group(0) and "user" in m.group(0)),
       m.group(0)[:90] if m else "无")
    ck("不用单一前缀的正则（避免护栏静默失效）",
       bool(m) and "?:" in m.group(0) and "|" in m.group(0),
       m.group(0)[:90] if m else "无")

    print("\n[2] __lineMode 的轮次下界")
    ck("签名带 lastUser 参数",
       re.search(r"function __lineMode\(l, i, gating, lastUser\)", cr_s) is not None)
    ck("用户行之前的 neuro 行整行显示",
       "lastUser >= 0 && i < lastUser" in cr_s and "return 'full'" in cr_s)

    print("\n[3] 游标推进的轮次下界")
    ck("__applyTtsProgress 计算 lastUserIdx",
       re.search(r"var lastUserIdx = -1;", cr_s) is not None)
    ck("segToken 分支 base 有下界",
       "if (lastUserIdx > base) base = lastUserIdx;" in cr_s)
    ck("兼容分支 base2 有下界",
       "if (lastUserIdx > base2) base2 = lastUserIdx;" in cr_s)
    ck("保持游标带轮次条件",
       re.search(r"__typer\.idx >= lastUserIdx", cr_s) is not None)
    ck("文本匹配跳过旧轮",
       "上一轮的行不参与匹配" in cr_s or
       re.search(r"neuro\[j\]\.idx < lastUserIdx\) continue", cr_s) is not None)
    ck("live 定位按轮次起算",
       re.search(r"neuro\[_lv\]\.idx < lastUserIdx\) continue", cr_s) is not None)
    ck("liveInRow 前缀基准跳过旧轮",
       re.search(r"neuro\[_pv\]\.idx < lastUserIdx\) continue", cr_s) is not None)

    print("\n[4] paint 把 lastUserIdx 传给 __lineMode")
    ck("paint 调用带 lastUserIdx",
       re.search(r"__lineMode\(l, i, gating, lastUserIdx\)", cr_s) is not None)

    print("\n[5] __roomApply 不得引用未定义的标识符")
    m2 = re.search(r"function __roomApply\(([^)]*)\)\{", cr_s)
    ck("__roomApply 存在", bool(m2))
    if m2:
        params = m2.group(1).split(",")[0].strip()
        # 取函数体
        start = cr_s.index("function __roomApply(")
        depth, i = 0, cr_s.index("{", start)
        for j in range(i, len(cr_s)):
            if cr_s[j] == "{":
                depth += 1
            elif cr_s[j] == "}":
                depth -= 1
                if depth == 0:
                    break
        body = cr_s[start:j + 1]
        # 去掉注释再找 cmd.
        body_nc = re.sub(r"//[^\n]*", "", body)
        body_nc = re.sub(r"/\*.*?\*/", "", body_nc, flags=re.S)
        # 判据：函数体里用的标识符必须在参数名里声明。
        # 原版参数叫 cmd（自洽，合法）；v1.0 参数叫 user 却仍用 cmd.op → ReferenceError。
        used = set(re.findall(r"\bcmd\s*\.", body_nc))
        ck("函数体内 cmd. 的用法与参数名一致（否则 ReferenceError）",
           (not used) or (params == "cmd"),
           "参数=%s，却仍引用 %s" % (params, sorted(used)))

    print("\n[6] 用户消息 CSS 类名")
    ck(".msg.cmd 与 .msg.user 都认",
       re.search(r"\.msg\.cmd\s*,\s*\.msg\.user", cr_s) is not None)
    co = os.path.join(ROOT, "js", "console.html")
    if os.path.exists(co):
        cos = read(co)
        ck("console .line.cmd 与 .line.user 都认",
           (".line.cmd" in cos and ".line.user" in cos
            and re.search(r"\.line\.cmd[^\n{]*,\s*[^\n{]*\.line\.user", cos) is not None),
           re.search(r"[^\n]*\.line\.cmd[^\n]*", cos).group(0)[:90]
           if re.search(r"[^\n]*\.line\.cmd[^\n]*", cos) else "无")

    print("\n[7] 后端 chat_log 截断保留 session 标记")
    for rel in ("backend/neuro_server.py",):
        p = os.path.join(ROOT, rel)
        if not os.path.exists(p):
            continue
        s = read(p)
        ck("%s 保留首行标记" % rel,
           re.search(r"_keep = list\(_lines\[:1\]\) \+ list\(_lines\[-\(MAX_CHAT_LOG_LINES - 1\):\]\)",
                     s) is not None)
        ck("%s 不再用裸的 _lines[-MAX:]" % rel,
           "f.writelines(_lines[-MAX_CHAT_LOG_LINES:])" not in s)

    print("\n[8] 行为验证：用真实日志复现越界")
    here = os.path.dirname(os.path.abspath(__file__))
    ver = os.path.join(here, "verify_subtitle_order.js")
    if os.path.exists(ver) and which_node():
        import subprocess
        r = subprocess.run([which_node(), ver, cr], capture_output=True,
                           text=True, encoding="utf-8", errors="replace")
        out = r.stdout or ""
        ck("游标不再越界", "✓ 游标落在用户消息之后" in out, out[-300:])
        ck("五个护栏全部就位", out.count("OK") >= 5, out[-300:])
    else:
        print("  SKIP  找不到 node 或 verify_subtitle_order.js")

    print("\n结果: %d PASS, %d FAIL" % (PASS, FAIL))
    return 1 if FAIL else 0


def which_node():
    for c in ("node", "node.exe"):
        for d in os.environ.get("PATH", "").split(os.pathsep):
            p = os.path.join(d, c)
            if os.path.exists(p):
                return p
    return "node"


if __name__ == "__main__":
    sys.exit(main())
