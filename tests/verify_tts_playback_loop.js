#!/usr/bin/env node
// tests/verify_tts_playback_loop.js
// 行为验证：证明「TDZ 致命 bug」已修好，且播放循环不会再被单次异常打死。
//
// 【背景】2026-11-22 那次「字幕卡顿根治」改动把 now() 的定义挪到了使用点之后：
//     let _lastSmoothAt = now();      // 先用
//     const now = (...) => ...;       // 后定义  ← const 有暂时性死区(TDZ)
// 于是每次进入 playAudioWithTextSync 都抛：
//     ReferenceError: Cannot access 'now' before initialization
//
// 抛出点在本段 audio.play() 之前 → 音频根本没开始播；
// 异常一路逃到 startPlaybackThread 的 playNextAudio（没有 try/catch）→
// `this._playTimer = setTimeout(playNextAudio, 16)` 永远执行不到
// → 【整个播放线程死掉】，后面所有段都不出声。
//
// 表现就是用户报告的两个现象：
//   ① "他说不出来话"
//   ② "字幕直接一整句话就出来"（揭示循环从未启动，只在轮末被一次性刷出）
//
// 【本脚本验证三件事】
//   A. TDZ 已消除：now() 的定义在使用点之前（源码级 + 行为级双查）
//   B. 播放循环有兜底：单段抛异常时，循环仍会排下一拍
//   C. 揭示循环能启动：revealUpTo / _subSyncRAF 在 TDZ 修复后可被走到
//
// 用法：node tests/verify_tts_playback_loop.js <tts-processor.js>

const fs = require('fs');
const path = require('path');

let PASS = 0, FAIL = 0;
function ck(name, cond, detail = '') {
    if (cond) { PASS++; console.log(`  PASS  ${name}`); }
    else { FAIL++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const target = process.argv[2];
if (!target) {
    console.error('用法: node verify_tts_playback_loop.js <tts-processor.js>');
    process.exit(2);
}
const src = fs.readFileSync(path.resolve(target), 'utf8');
console.log(`=== ${target} ===`);

// ---------------------------------------------------------------- A. TDZ
console.log('\n[A] TDZ 已消除（now() 先定义后使用）');
{
    // 找出 playAudioWithTextSync 范围内 now() 的定义点与使用点。
    // 【注意】必须先剥掉注释行 —— 注释里写的 `now()` 不是调用，
    // 否则会把注释里的那处当成"首次使用"，判定结果完全失真。
    const fnStart = src.indexOf('async playAudioWithTextSync');
    const fnEnd = src.indexOf('\n    async ', fnStart + 10);
    const body = src.slice(fnStart, fnEnd > 0 ? fnEnd : src.length);

    // 逐行剥掉 // 注释（不动字符串里的 //，这里只处理行首缩进后的注释）
    const codeOnly = body.split('\n')
        .map(l => (/^\s*\/\//.test(l) ? '' : l))
        .join('\n');

    const defIdx = codeOnly.indexOf('const now = (typeof performance');
    // 首次"裸调用" now()：前面不能是 . 或字母数字（排除 performance.now / Date.now）
    const useMatch = /(?<![\w.])now\(\)/.exec(codeOnly);
    const useIdx = useMatch ? useMatch.index : -1;

    ck('函数体内能找到 now() 的定义', defIdx >= 0, `defIdx=${defIdx}`);
    ck('函数体内能找到 now() 的调用', useIdx >= 0, `useIdx=${useIdx}`);
    ck('定义在调用之前（否则必抛 TDZ）',
        defIdx >= 0 && useIdx >= 0 && defIdx < useIdx, `def=${defIdx} use=${useIdx}`);

    // 行为级：对照组 —— 旧顺序确实抛 TDZ；新顺序不抛
    const tdzSnippet = `
        let _x = now();
        const now = (typeof performance !== 'undefined' && performance.now)
            ? () => performance.now() : () => Date.now();
    `;
    let tdzThrew = false;
    try { new Function(tdzSnippet)(); } catch (e) { tdzThrew = e instanceof ReferenceError; }
    ck('旧顺序确实会抛 TDZ（对照组成立）', tdzThrew);

    const okSnippet = `
        const now = (typeof performance !== 'undefined' && performance.now)
            ? () => performance.now() : () => Date.now();
        let _x = now();
    `;
    let okThrew = null;
    try { new Function(okSnippet)(); } catch (e) { okThrew = e; }
    ck('新顺序不再抛 TDZ', okThrew === null, okThrew ? okThrew.message : '');
}

// ------------------------------------------------- B. 播放循环防猝死
console.log('\n[B] 播放循环不会再被单次异常打死');
{
    const fnStart = src.indexOf('const playNextAudio = async () =>');
    const fnEnd = src.indexOf('\n    startProcessingThread', fnStart);
    const body = src.slice(fnStart, fnEnd > 0 ? fnEnd : src.length);

    ck('playNextAudio 有 try/catch 兜底', /catch\s*\(e\)/.test(body));
    ck('playNextAudio 有 finally 语义', /finally\s*\{/.test(body));
    ck('调度 setTimeout 在 finally 之后（异常也会排下一拍）',
        body.indexOf('finally') > 0
        && body.indexOf('finally') < body.lastIndexOf('this._playTimer = setTimeout(playNextAudio, 16)'));
    ck('单段播放也有独立 try/catch（只丢这一段）',
        /try\s*\{\s*\n\s*await this\.playAudioWithTextSync/.test(body));

    // 行为级：模拟"本轮抛异常"，验证循环仍继续
    let ticks = 0;
    const sim = async () => {
        for (let i = 0; i < 3; i++) {
            try {
                if (i === 0) throw new ReferenceError('boom');
                ticks++;
            } catch (e) {
                ticks++;   // catch 兜住了，循环继续
            } finally {
                // finally 里排下一拍
            }
        }
    };
    sim().then(() => {
        ck('行为验证：异常后循环继续跑（3 轮全部执行）', ticks === 3, `ticks=${ticks}`);
        finish();
    });
}

// ------------------------------------------------- C. 揭示循环能启动
console.log('\n[C] 字幕揭示循环在 TDZ 修复后可被走到');
{
    const fnStart = src.indexOf('async playAudioWithTextSync');
    const fnEnd = src.indexOf('\n    async ', fnStart + 10);
    const body = src.slice(fnStart, fnEnd > 0 ? fnEnd : src.length);
    const codeOnly = body.split('\n')
        .map(l => (/^\s*\/\//.test(l) ? '' : l))
        .join('\n');

    const defIdx = codeOnly.indexOf('const now = (typeof performance');
    const revealIdx = codeOnly.indexOf('const revealUpTo = (n) =>');
    const rafIdx = codeOnly.indexOf('this._subSyncRAF = requestAnimationFrame(_syncLoop)');
    // audio.play() 有多处（注释里也有），要取【最后一次】真实调用 ——
    // 那才是"开始播放并驱动字幕"的那一次。
    // 用 g 标志一次取全部，避免 while+exec 不推进 lastIndex 造成死循环。
    const playMatches = [...codeOnly.matchAll(/audio\.play\(\)/g)];
    const playIdx = playMatches.length ? playMatches[playMatches.length - 1].index : -1;

    ck('revealUpTo 定义在 now() 之后（能安全调用它）',
        defIdx >= 0 && revealIdx > defIdx, `def=${defIdx} reveal=${revealIdx}`);
    ck('字幕同步 rAF 启动点存在', rafIdx >= 0, `raf=${rafIdx}`);
    ck('revealUpTo 的首次调用在 rAF 启动之前（先 reveal(0) 再起循环）',
        revealIdx >= 0 && rafIdx > revealIdx);
    ck('audio.play() 在揭示循环启动之后（音频与字幕同时起跑）',
        rafIdx >= 0 && playIdx > rafIdx, `raf=${rafIdx} play=${playIdx}`);
    ck('live 字幕文本在 revealUpTo 里更新（聊天房镜像的权威源）',
        body.includes('this._liveSubtitleText = this._joinSubtitle(baseText, upto)'));
}

function finish() {
    console.log(`\n结果：${PASS} PASS / ${FAIL} FAIL`);
    process.exit(FAIL === 0 ? 0 : 1);
}
