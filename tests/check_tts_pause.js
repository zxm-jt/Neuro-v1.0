'use strict';
const path = require('path');
const { EnhancedTextProcessor } = require(path.join(__dirname, '..', 'js', 'tts-processor.js'));

let PASS = 0, FAIL = 0;
function ck(name, cond, detail = '') {
    if (cond) { PASS++; console.log(`  PASS  ${name}`); }
    else { FAIL++; console.log(`  FAIL  ${name}  ${detail}`); }
}
function sec(t) { console.log(`\n=== ${t} ===`); }

function makeProc() {
    const p = Object.create(EnhancedTextProcessor.prototype);
    p.textSegmentQueue = [];
    p.audioDataQueue = [];
    p.syncTextQueue = [];
    p.pendingSegment = '';
    p._segToken = 0;
    p._fillGen = 0;
    p._subRAF = null;
    p._fillRAF = null;
    p._ttsSeq = 0;
    p._ttsEpoch = 0;
    p._nextSeqToPush = 0;
    p._pendingAudios = new Map();
    p._synthInFlight = 0;
    p._pgIdx = 0;
    p._pgText = '';
    p._pgTotal = 1;
    p._pgMax = 240;
    p._currentTurn = 3;
    p.currentTurn = 3;
    p.maxSegmentChars = 70;
    p.shouldStop = false;
    p._audioPlaying = false;
    p.isProcessing = false;
    p.currentAudio = null;
    p._sentenceBuf = '';
    p._tagHold = '';
    p._wordHold = '';
    p._wordHoldAt = 0;
    p._punctHold = '';
    p._roundEmotion = null;
    p._fastFirstSegDone = false;
    p.llmFullResponse = 'I already said this.';
    p.displayedText = 'I already said this.';
    p._spokenText = 'I already said this.';
    p._spokenOffset = 20;
    p._completedSegments = ['I already said this.'];
    p._curSegTotal = 20;
    p._curSegRevealed = 20;
    p.currentSegmentText = 'And now this bit.';
    p._roundEmotion = 'happy';
    p._sent = [];
    p._enqueueSegment = function (text) { this._sent.push(text); };
    return p;
}

const SENT_END = ['.', '!', '?', '。', '！', '？', '…', '‼', '⁇', '⁈', '⁉'];
function endsWithPunct(s) {
    const t = s.replace(/\s+$/, '');
    return SENT_END.includes(t.charAt(t.length - 1));
}

sec('[1] _smartSplit 只在句末标点处切');
{
    const p = makeProc();
    const text = 'I keep telling you, and I mean this sincerely, that the little '
        + 'things matter more than the big ones, especially on quiet evenings '
        + 'like this one. Then you laugh, and I forget what I was saying.';
    const segs = p._smartSplit(text, 70);
    ck('完整句【一次合成】不切碎（内部零接缝）', segs.length === 1,
        `段数=${segs.length} → ${segs.map(s => JSON.stringify(s.slice(-18))).join(' | ')}`);
    ck('整段以句末标点结尾', segs.every(endsWithPunct),
        segs.map(s => JSON.stringify(s.slice(-18))).join(' | '));
    ck('没有任何段以逗号/分号/冒号结尾',
        segs.every(s => !/[,;:，；：]\s*$/.test(s)),
        segs.map(s => JSON.stringify(s.slice(-12))).join(' | '));
    ck('拼接后逐字符还原原文（不丢空格）', segs.join('') === text,
        `原文长度=${text.length} 拼接长度=${segs.join('').length}`);

    // 超过 HARD_SPLIT_CHARS(300) 的真·超长文本：每个切点仍必须落在句末标点
    const long = text + ' ' + text + ' ' + text;
    const longSegs = p._smartSplit(long, 70);
    ck('超长文本确实被切成多段', longSegs.length >= 2, `段数=${longSegs.length}`);
    ck('超长文本每段都以句末标点结尾', longSegs.every(endsWithPunct),
        longSegs.map(s => JSON.stringify(s.slice(-18))).join(' | '));
    ck('超长文本拼接仍逐字符还原', longSegs.join('') === long,
        `原文=${long.length} 拼接=${longSegs.join('').length}`);
}

sec('[2] 不会把英文单词从中间切开');
{
    const p = makeProc();
    const text = 'The extraordinarily complicated configuration of the '
        + 'refrigerator confused everybody in the kitchen that evening. '
        + 'Nobody said anything about it. We just ate dinner quietly.';
    const segs = p._smartSplit(text, 60);
    let splitInsideWord = false;
    for (let i = 0; i < segs.length - 1; i++) {
        const a = segs[i].replace(/\s+$/, '');
        const b = segs[i + 1].replace(/^\s+/, '');
        const last = a.charAt(a.length - 1), first = b.charAt(0);
        if (/[A-Za-z]/.test(last) && /[A-Za-z]/.test(first)) splitInsideWord = true;
    }
    ck('段间接缝没有把单词劈成两半', !splitInsideWord,
        segs.map(s => JSON.stringify(s.slice(-15))).join(' | '));
    ck('每段以句末标点结尾', segs.every(endsWithPunct),
        segs.map(s => JSON.stringify(s.slice(-15))).join(' | '));
    ck('拼接逐字符还原', segs.join('') === text);
}

sec('[3] 标点集合的行为');
{
    const p = makeProc();
    const cases = [
        ['Hi. Then?', 'Hi. Then?'],
        ['好。然后呢！', '好。然后呢！'],
        ['等等…', '等等…'],
        ['Wait... let me think.', 'Wait... let me think.'],
        ['It is 3.5 seconds.', 'It is 3.5 seconds.'],   // 小数点不能被当成句末
    ];
    for (const [text, want] of cases) {
        const got = p._smartSplit(text, 70);
        ck(`完整句不切碎 ${JSON.stringify(text)}`,
            got.length === 1 && got[0] === want,
            `得到 ${JSON.stringify(got)}，期望单段 ${JSON.stringify(want)}`);
    }
    // 短于上限的文本不该被切
    ck('短句不切（逗号不构成切点）',
        JSON.stringify(p._smartSplit('Sure, go ahead, I am listening.', 70))
        === JSON.stringify(['Sure, go ahead, I am listening.']));
}

sec('[4] _drainSentences 不再引用已删除的旧常量');
{
    const src = require('fs').readFileSync(
        path.join(__dirname, '..', 'js', 'tts-processor.js'), 'utf8');
    for (const k of ['CLAUSE_FLUSH_CHARS', 'FIRST_SEG_FAST_CHARS',
                     'WEAK_BOUNDARY_CHARS', 'SENTENCE_MAX_CHARS']) {
        // 注释里提到旧常量是留档，允许；但代码里绝不能出现 `k` 作为标识符使用
        const used = new RegExp('(?:const|let|var|\\bif|\\breturn|>=|<=|===)\\s*[^\\n]*\\b' + k + '\\b').test(src);
        ck(`代码里没有引用已删常量 ${k}`, !used);
    }
    const p = makeProc();
    // 攒到句末标点才放出一整句：逗号/空格阶段不能提前 flush
    p._sentenceBuf = 'I was thinking about it, and then I wondered whether ';
    p._drainSentences(false);
    ck('只有逗号+空格时不提前切（不抢在标点前停）', p._sent.length === 0,
        `送出了 ${p._sent.length} 段: ${JSON.stringify(p._sent)}`);
    p._sentenceBuf += 'you would agree. ';
    p._drainSentences(false);
    ck('句末标点到达后才送出一整句', p._sent.length === 1 && endsWithPunct(p._sent[0]),
        JSON.stringify(p._sent));
    ck('句子内容完整不丢字', p._sent[0].includes('I was thinking about it, and then'),
        JSON.stringify(p._sent[0]));
    p._sentenceBuf = 'One last thing';
    p._drainSentences(true);
    ck('force 放出残余半句', p._sent.length === 2 && p._sent[1] === 'One last thing',
        JSON.stringify(p._sent));
}

sec('[5] stopAudioOnly(): 停播清队列，但完整保留已说上下文');
{
    const p = makeProc();
    p._audioPlaying = true;
    p.isProcessing = true;
    p.textSegmentQueue.push({ text: 'queued one' }, { text: 'queued two' });
    p.audioDataQueue.push({ text: 'audio one' });
    p.syncTextQueue.push('sync one');
    p.pendingSegment = 'not yet a sentence';
    p._sentenceBuf = 'half a sentence';
    p._pendingAudios.set(7, { text: 'in flight' });
    p._synthInFlight = 2;

    let paused = 0, dispatched = 0;
    p.currentAudio = {
        pause() { paused++; },
        dispatchEvent(ev) { if (ev && ev.type === 'ended') dispatched++; }
    };
    p.onAudioDataCallback = () => {};
    global.Event = class Event { constructor(type) { this.type = type; } };

    p.stopAudioOnly();

    ck('当前音频被 pause', paused === 1, `pause=${paused}`);
    ck('派发 ended 解锁播放线程（不会卡死）', dispatched === 1, `dispatch=${dispatched}`);
    ck('currentAudio 已清空', p.currentAudio === null);
    ck('待播文本队列清空', p.textSegmentQueue.length === 0);
    ck('待播音频队列清空', p.audioDataQueue.length === 0);
    ck('字幕同步队列清空', p.syncTextQueue.length === 0);
    ck('未成段缓冲清空', p.pendingSegment === '' && p._sentenceBuf === '');
    ck('在途合成回调作废（代号递增）', p._ttsEpoch === 1 && p._pendingAudios.size === 0);
    ck('_audioPlaying/isProcessing 复位', p._audioPlaying === false && p.isProcessing === false);

    // ★ 已说上下文必须一个字节都不变
    ck('llmFullResponse 保留', p.llmFullResponse === 'I already said this.', p.llmFullResponse);
    ck('displayedText 保留', p.displayedText === 'I already said this.', p.displayedText);
    ck('_spokenText 保留', p._spokenText === 'I already said this.', p._spokenText);
    ck('_spokenOffset 保留', p._spokenOffset === 20, String(p._spokenOffset));
    ck('_completedSegments 保留', p._completedSegments.length === 1
        && p._completedSegments[0] === 'I already said this.', JSON.stringify(p._completedSegments));
    ck('_curSegTotal/_curSegRevealed 保留',
        p._curSegTotal === 20 && p._curSegRevealed === 20);
    ck('currentSegmentText 保留', p.currentSegmentText === 'And now this bit.');
    ck('_roundEmotion 保留', p._roundEmotion === 'happy', String(p._roundEmotion));
    ck('taskId(_currentTurn) 不变（避免 gen 错位 bug）', p._currentTurn === 3, String(p._currentTurn));
    ck('segment token 递增（半段不会被误记为已播完）', p._segToken === 1, String(p._segToken));
}

sec('[6] reset() 才清掉已说上下文');
{
    const p = makeProc();
    p.currentAudio = null;
    p.onAudioDataCallback = null;
    p._endFired = false;
    p._exprOnlyTimer = null;
    p._ttsSeq = 0;
    global.cancelAnimationFrame = () => {};
    global.updateSubtitlePage = () => {};
    p.reset();
    ck('reset 清空 llmFullResponse', p.llmFullResponse === '');
    ck('reset 清空 _spokenText', p._spokenText === '');
    ck('reset 清空 _completedSegments', p._completedSegments.length === 0);
    ck('reset 清空 displayedText', p.displayedText === '');
    ck('reset 递增 _currentTurn（新一轮）', p._currentTurn === 4, String(p._currentTurn));
}

sec('[7] 回归：isPlaying() 方法不再被布尔字段遮蔽');
{
    const p = Object.create(EnhancedTextProcessor.prototype);
    p._audioPlaying = false;
    p.isProcessing = false;
    p.textSegmentQueue = [];
    p.audioDataQueue = [];
    ck('isPlaying 是函数', typeof p.isPlaying === 'function', typeof p.isPlaying);
    ck('空闲时返回 false', p.isPlaying() === false);
    p._audioPlaying = true;
    ck('播放中返回 true', p.isPlaying() === true);
    p._audioPlaying = false;
    p.audioDataQueue.push({});
    ck('队列有存货时返回 true', p.isPlaying() === true);
}

sec('[8] 回归：单个 chunk 异常不会吞掉整轮文字');
{
    const p = makeProc();
    p._logEmotion = () => {};
    const origErr = console.error;
    console.error = () => {};   // 静音，避免污染输出
    let calls = 0;
    const origDrain = p._drainSentences;
    p._drainSentences = function (force) {
        calls++;
        if (calls === 1) throw new ReferenceError('CLAUSE_FLUSH_CHARS is not defined');
        return origDrain.call(this, force);
    };
    p.shouldStop = false;
    p._currentTurn = 3;
    let threw = false;
    try {
        p.addStreamingText('First bit. ', 3);   // 这一次会抛错但必须被内部兜住
        p.addStreamingText('Second bit. ', 3);  // 后续 chunk 必须继续进缓冲
        p.addStreamingText('Third bit.', 3);
    } catch (e) { threw = true; }
    console.error = origErr;
    ck('异常没有冒泡到 SSE 循环', !threw);
    const sent = (p._sent || []).join('');
    ck('后续 chunk 没有整轮丢失（都进了 TTS 队列）',
        sent.includes('Second bit.') && sent.includes('Third bit.'),
        `队列=${JSON.stringify(p._sent)} 缓冲=${JSON.stringify(p._sentenceBuf)}`);
    ck('三次切分都被尝试过', calls >= 3, `calls=${calls}`);
}

console.log(`\n结果：${PASS} PASS / ${FAIL} FAIL`);
process.exit(FAIL ? 1 : 0);
