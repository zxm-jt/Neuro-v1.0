# -*- coding: utf-8 -*-
"""
check_tts_playback_loop.py —— 锁住"播放线程不会被打死"+"字幕揭示循环能启动"

【回归背景】
2026-11-22 那次「字幕卡顿根治」改动里，now() 的定义被挪到了使用点【之后】：

    let _lastSmoothAt = now();      // 先用
    const now = (...) => ...;       // 后定义   ← const 有暂时性死区(TDZ)

于是每次进入 playAudioWithTextSync 都抛
    ReferenceError: Cannot access 'now' before initialization

后果是链式的、且每一环都很致命：
  ① 抛出点在本段 audio.play() 之前 → 音频根本没开始播
  ② 异常从 playAudioWithTextSync 一路逃到 startPlaybackThread 的
     playNextAudio（那一层没有 try/catch）
  ③ playNextAudio 被 reject → `this._playTimer = setTimeout(playNextAudio, 16)`
     永远执行不到 → 【整个播放线程就此死掉】，后续所有段都不出声
  ④ 字幕揭示循环（revealUpTo / _subSyncRAF）从未启动 → 字幕只在轮末被
     一次性刷出 → 用户看到"直接一整句话就出来了"

用户报告的两个现象其实是【同一条原因链】：
  - "他说不出来话"        → ③ 播放线程死了
  - "字幕整句直接出来"     → ④ 揭示循环没启动

【断言】
1. now() 的定义在使用之前（TDZ 根因）
2. 播放循环有 catch 兜底 + finally 调度（结构性防线）
3. 单段播放有独立 try/catch（只丢这一段，不拖死整轮）
4. 揭示循环在 TDZ 修复后可被走到（revealUpTo / rAF / audio.play 顺序）
5. live 字幕文本在 revealUpTo 里更新（聊天房镜像的权威数据源）
6. 行为验证：跑 verify_tts_playback_loop.js
"""
import io
import os
import re
import subprocess
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


def strip_line_comments(s):
    """剥掉整行 // 注释 —— 否则注释里写的 now() 会被当成真实调用。"""
    return "\n".join("" if re.match(r"^\s*//", ln) else ln for ln in s.split("\n"))


def main():
    tp = os.path.join(ROOT, "js", "tts-processor.js")
    if not os.path.exists(tp):
        print("  SKIP  找不到 tts-processor.js")
        return 0
    s = read(tp)

    # 只取 playAudioWithTextSync 函数体（下一个 "async " 之前）
    fn_start = s.find("async playAudioWithTextSync")
    fn_end = s.find("\n    async ", fn_start + 10)
    body = s[fn_start:fn_end if fn_end > 0 else len(s)]
    code = strip_line_comments(body)

    print("[1] TDZ 根因：now() 必须先定义后使用")
    def_idx = code.find("const now = (typeof performance")
    m = re.search(r"(?<![\w.])now\(\)", code)
    use_idx = m.start() if m else -1
    ck("找得到 now() 的定义", def_idx >= 0, "def=%d" % def_idx)
    ck("找得到 now() 的调用", use_idx >= 0, "use=%d" % use_idx)
    ck("定义在调用之前（否则必抛 TDZ）",
       def_idx >= 0 and use_idx >= 0 and def_idx < use_idx,
       "def=%d use=%d" % (def_idx, use_idx))

    print("\n[2] 播放循环防猝死")
    pl_start = s.find("const playNextAudio = async () =>")
    pl_end = s.find("\n    startProcessingThread", pl_start)
    pl = s[pl_start:pl_end if pl_end > 0 else len(s)]
    ck("playNextAudio 有 catch 兜底", re.search(r"catch\s*\(e\)", pl) is not None)
    ck("playNextAudio 有 finally 语义", re.search(r"finally\s*\{", pl) is not None)
    fin = pl.find("finally")
    last_sched = pl.rfind("this._playTimer = setTimeout(playNextAudio, 16)")
    ck("调度 setTimeout 在 finally 之后（异常也会排下一拍）",
       fin > 0 and last_sched > fin, "finally=%d sched=%d" % (fin, last_sched))
    ck("单段播放有独立 try/catch（只丢这一段）",
       re.search(r"try\s*\{\s*\n\s*await this\.playAudioWithTextSync", pl) is not None)

    print("\n[3] 字幕揭示循环能启动")
    reveal_idx = code.find("const revealUpTo = (n) =>")
    raf_idx = code.find("this._subSyncRAF = requestAnimationFrame(_syncLoop)")
    plays = [mm.start() for mm in re.finditer(r"audio\.play\(\)", code)]
    play_idx = plays[-1] if plays else -1
    ck("revealUpTo 定义在 now() 之后（能安全调用它）",
       def_idx >= 0 and reveal_idx > def_idx,
       "def=%d reveal=%d" % (def_idx, reveal_idx))
    ck("字幕同步 rAF 启动点存在", raf_idx >= 0)
    ck("先 revealUpTo(0) 再起 rAF 循环",
       reveal_idx >= 0 and raf_idx > reveal_idx)
    ck("audio.play() 在揭示循环启动之后（音频与字幕同时起跑）",
       raf_idx >= 0 and play_idx > raf_idx,
       "raf=%d play=%d" % (raf_idx, play_idx))
    ck("live 字幕文本在 revealUpTo 里更新（聊天房镜像权威源）",
       "this._liveSubtitleText = this._joinSubtitle(baseText, upto)" in body)

    print("\n[4] 行为验证")
    ver = os.path.join(ROOT, "tests", "verify_tts_playback_loop.js")
    node = which_node()
    if os.path.exists(ver) and node:
        r = subprocess.run([node, ver, tp], capture_output=True,
                           text=True, encoding="utf-8", errors="replace")
        out = r.stdout or ""
        ck("TDZ 已消除且播放循环有兜底",
           "结果：15 PASS / 0 FAIL" in out, out[-300:])
        ck("对照组证明旧顺序确实会抛 TDZ",
           "旧顺序确实会抛 TDZ（对照组成立）" in out, out[-300:])
    else:
        print("  SKIP  找不到 node 或 verify_tts_playback_loop.js")

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
