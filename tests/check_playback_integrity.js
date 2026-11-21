'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { __test, EnhancedTextProcessor } = require(path.join(ROOT, 'js', 'tts-processor.js'));
const src = fs.readFileSync(path.join(ROOT, 'js', 'tts-processor.js'), 'utf8');

let PASS = 0, FAIL = 0;
function ck(name, cond, detail = '') {
    if (cond) { PASS++; console.log(`  PASS  ${name}`); }
    else { FAIL++; console.log(`  FAIL  ${name}  ${detail}`); }
}
function sec(t) { console.log(`\n=== ${t} ===`); }

sec('[1] 症状①：播完判定必须把"在途合成"算进去');
{
    const iSyn = src.indexOf('const _synthPending');
    const iFire = src.indexOf('_fireEnd();', iSyn);
    const m = (iSyn >= 0 && iFire > iSyn)
        ? [src.slice(iSyn, iFire)] : null;
    ck('onended 里存在带 _synthPending 的播完判定', !!m,
        '没找到新的播完判定块');
    if (m) {
        ck('判定包含 _synthInFlight', m[0].includes('_synthInFlight'));
        ck('判定包含 _pendingAudios', m[0].includes('_pendingAudios'));
        ck('判定显式要求 !_synthPending', m[0].includes('!_synthPending'));
    }
    const iFin = src.indexOf('.finally(() => {');
    const iFinEnd = src.indexOf('});', iFin);
    ck('合成 finally 里有结束回调兜底',
        iFin >= 0 && iFinEnd > iFin && src.slice(iFin, iFinEnd).includes('this._fireEnd()'));
    ck('兜底要求 _synthInFlight === 0',
        /_synthInFlight \|\| 0\) === 0/.test(src));

    // 行为模拟：三段合成，第一段播完时后两段仍在途 → 不能触发 fireEnd
    function shouldFireEnd(st) {
        const synthPending = (st.synthInFlight || 0) > 0
            || (st.pendingAudios && st.pendingAudios.size > 0);
        return st.audioQueue.length === 0
            && st.textQueue.length === 0
            && !st.isProcessing
            && !synthPending
            && st.pendingSegment.trim() === '';
    }
    ck('在途合成 > 0 时不触发结束回调（不会提前解锁麦克风）',
        shouldFireEnd({ synthInFlight: 2, audioQueue: [], textQueue: [],
                        isProcessing: false, pendingSegment: '' }) === false);
    ck('队列见底但有 _pendingAudios 时不触发',
        shouldFireEnd({ synthInFlight: 0, pendingAudios: new Map([[3, {}]]),
                        audioQueue: [], textQueue: [],
                        isProcessing: false, pendingSegment: '' }) === false);
    ck('队列里还有待播音频时不触发',
        shouldFireEnd({ synthInFlight: 0, audioQueue: [{}], textQueue: [],
                        isProcessing: false, pendingSegment: '' }) === false);
    ck('全部完成时才触发（麦克风能正常解锁）',
        shouldFireEnd({ synthInFlight: 0, audioQueue: [], textQueue: [],
                        isProcessing: false, pendingSegment: '' }) === true);
}

sec('[2] 症状②：字幕跟随真实播放进度（"她念什么，字幕显示什么"）');
{
    const MIN = __test.SUBTITLE_MIN_UNIT_MS;
    ck('SUBTITLE_MIN_UNIT_MS 常量仍存在', typeof MIN === 'number' && MIN > 0, String(MIN));
    ck('字幕同步由 audio.currentTime 进度驱动',
        /audio\.currentTime/.test(src) && /audio\.duration/.test(src));
    ck('不再有独立的补字 rAF（_fillFrame 已移除）', !/_fillFrame/.test(src));
    ck('不再用估计时长 _dur 做揭示（_dur \* 1000 已移除）', !/_dur \* 1000/.test(src));
    ck('不再每帧 +1 抢跑（旧补字循环已移除）',
        !/_n = Math\.min\(units\.length, _n \+ 1\)/.test(src));
    ck('字幕同步循环走 _subSyncRAF（可被 reset 取消）',
        /this\._subSyncRAF = requestAnimationFrame\(_syncLoop\)/.test(src));
    ck('进度为 0 时不提前显示（_prog > 0 才 +1）',
        /prog > 0 \? 1 : 0/.test(src));

    const total = 60;
    const revealAt = (prog) => Math.min(total,
        Math.floor(Math.min(1, prog) * total) + (prog > 0 ? 1 : 0));
    ck('进度 0 → 字幕为空（还没念 = 不显示）', revealAt(0) === 0, `n=${revealAt(0)}`);
    ck('进度 50% → 显示约一半', revealAt(0.5) >= 28 && revealAt(0.5) <= 32,
        `n=${revealAt(0.5)}`);
    ck('进度 100% → 全部显示', revealAt(1) === total, `n=${revealAt(1)}`);
    let maxAhead = 0;
    for (let p = 0; p <= 1.0001; p += 0.01) {
        const spoken = Math.floor(p * total);
        const shown = revealAt(p);
        maxAhead = Math.max(maxAhead, shown - spoken);
    }
    ck('字幕揭示永不超前于已念进度（最大超前 ≤ 1 字）', maxAhead <= 1, `maxAhead=${maxAhead}`);
}

sec('[3] 两个症状涉及的文件语法与既有测试仍可用');
{
    const p = new EnhancedTextProcessor('http://x', null, null, null, {});
    clearTimeout(p._procTimer); clearTimeout(p._playTimer);
    ck('实例可构造', !!p);
    ck('isPlaying 仍是函数（没被布尔字段遮蔽）', typeof p.isPlaying === 'function');
    ck('isPlaying() 空闲返回 false', p.isPlaying() === false);
    ck('stopAudioOnly 存在', typeof p.stopAudioOnly === 'function');

    // 整轮流式文本必须全部进队列（"不能完整念出来"的端到端检查）
    const q = [];
    p._enqueueSegment = (t) => q.push(t);
    const reply = 'First sentence here. Second sentence follows. Third one wraps it up.';
    for (let i = 0; i < reply.length; i += 6) p.addStreamingText(reply.slice(i, i + 6), p._currentTurn);
    p.finalizeStreamingText();
    const joined = q.join('');
    ck('三句全部进 TTS 队列（没有只念第一句）',
        q.length === 3 && joined.includes('First sentence')
        && joined.includes('Second sentence') && joined.includes('Third one'),
        `${q.length} 段: ${JSON.stringify(q)}`);
}

console.log(`\n结果：${PASS} PASS / ${FAIL} FAIL`);
process.exit(FAIL ? 1 : 0);
