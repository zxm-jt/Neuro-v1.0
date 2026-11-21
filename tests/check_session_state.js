'use strict';
const path = require('path');
const {
    UserTurnSession, STATE, COMMIT_HOLD_MS, WAIT_HOLD_MS, MAX_HOLD_MS,
    joinUtterances, isWaitCue, isFastFinish, looksComplete,
} = require(path.join(__dirname, '..', 'js', 'session-state.js'));

let PASS = 0, FAIL = 0;
function ck(name, cond, detail = '') {
    if (cond) { PASS++; console.log(`  PASS  ${name}`); }
    else { FAIL++; console.log(`  FAIL  ${name}  ${detail}`); }
}
function sec(t) { console.log(`\n=== ${t} ===`); }

function makeHarness(opts = {}) {
    let now = 1000;
    const commits = [];
    const s = new UserTurnSession(Object.assign({
        now: () => now,
        onCommit: (p) => commits.push(p),
    }, opts));
    return {
        s, commits,
        get now() { return now; },
        advance(ms) { now += ms; return s.tick(now); },
        push(text, o = {}) { return s.push(text, Object.assign({ taskId: s.currentTaskId() }, o)); },
    };
}

sec('[1] 连续说话 / 多次停顿 / 长时间思考 → 一次完整输入');
{
    const h = makeHarness();
    h.push('我想问个问题');
    h.advance(200);
    h.push('就是关于那个火箭发动机');
    h.advance(300);
    h.push('要用 C++ 重写');
    h.advance(150);
    h.push('还要接 OpenFOAM 仿真');
    ck('收集中不提前提交（没有抢答）', h.commits.length === 0,
        `已提交 ${h.commits.length} 次`);
    ck('状态 = collecting', h.s.state === STATE.COLLECTING, h.s.state);
    const r = h.advance(COMMIT_HOLD_MS + 50);
    ck('静音窗口到期后提交一次', r.committed === true && h.commits.length === 1,
        JSON.stringify(h.commits.map(c => c.text)));
    const text = h.commits[0].text;
    ck('四段都合并进来了（无丢字）',
        text.includes('我想问个问题') && text.includes('就是关于那个火箭发动机')
        && text.includes('要用 C++ 重写') && text.includes('还要接 OpenFOAM 仿真'), text);
    ck('顺序正确', text.indexOf('我想问个问题') < text.indexOf('就是关于')
        && text.indexOf('就是关于') < text.indexOf('要用'), text);
    ck('没有重复片段', text.split('我想问个问题').length === 2, text);
    ck('提交后状态 = answering', h.s.state === STATE.ANSWERING, h.s.state);
    ck('提交带明确 taskId', h.commits[0].taskId === 1, String(h.commits[0].taskId));
    ck('提交带 segments 明细（4 段）', h.commits[0].segments.length === 4,
        String(h.commits[0].segments.length));
}

{
    const h = makeHarness();
    h.push('嗯');
    h.advance(1800);          // 长时间思考（接近硬上限）
    h.push('我想到了，应该是这样。');
    ck('长静音后没有把前半段单独提交', h.commits.length === 0,
        JSON.stringify(h.commits.map(c => c.text)));
    h.advance(COMMIT_HOLD_MS + 50);
    ck('思考后继续说 → 仍合并成一次', h.commits.length === 1,
        JSON.stringify(h.commits.map(c => c.text)));
    ck('合并结果含前后两段', h.commits[0].text.includes('嗯')
        && h.commits[0].text.includes('我想到了'), h.commits[0].text);
}

{
    const h = makeHarness();
    for (let i = 0; i < 6; i++) { h.push('第' + (i + 1) + '段'); h.advance(100); }
    h.advance(COMMIT_HOLD_MS + 50);
    ck('6 段多次停顿只提交一次', h.commits.length === 1, String(h.commits.length));
    ck('6 段内容全在', ['第1段','第2段','第3段','第4段','第5段','第6段']
        .every(x => h.commits[0].text.includes(x)), h.commits[0].text);
}

// 硬上限：绝不无限悬挂
{
    const h = makeHarness();
    h.push('一段很长的话没有句末标点而且一直不说完');
    const r = h.advance(MAX_HOLD_MS + 100);
    ck('到硬上限必提交（不悬挂）', r.committed === true || h.commits.length === 1,
        `state=${h.s.state} commits=${h.commits.length}`);
}

sec('[2] 等待状态："等一下 / 让我想想" → 不抢先回复');
for (const cue of ['等一下', '等下', '让我想想', '我想想', 'hold on', 'wait', 'let me think']) {
    const h = makeHarness();
    h.push('我先说个事');
    h.push(cue);
    ck(`"${cue}" 进入 waiting`, h.s.state === STATE.WAITING, h.s.state);
    const before = h.advance(COMMIT_HOLD_MS + 100);
    ck(`"${cue}" 普通静音窗口内不提交`, before.committed === false && h.commits.length === 0,
        `commits=${h.commits.length}`);
}
{
    const h = makeHarness();
    h.push('等一下，让我想想');
    ck('明确进入 waiting', h.s.state === STATE.WAITING, h.s.state);
    ck('等待期间 3 秒不提交（不抢先回复）', h.advance(3000).committed === false);
    h.push('想到了，我们这样做吧。');
    ck('等待后继续说 → 回到 collecting', h.s.state === STATE.COLLECTING, h.s.state);
    h.advance(COMMIT_HOLD_MS + 50);
    ck('等待 + 后续内容合并成一次提交', h.commits.length === 1,
        JSON.stringify(h.commits.map(c => c.text)));
    ck('合并结果含等待语与后续内容', h.commits[0].text.includes('等一下')
        && h.commits[0].text.includes('我们这样做吧'), h.commits[0].text);
    ck('提交原因标记为等待后续说', ['silence_timeout', 'wait_timeout'].includes(h.commits[0].reason),
        h.commits[0].reason);
}
{
    const h = makeHarness();
    h.push('等一下');
    h.advance(WAIT_HOLD_MS + 100);
    ck('等待超时也必提交（绝不无限悬挂）', h.commits.length === 1,
        String(h.commits.length));
    ck('超时原因 = wait_timeout', h.commits[0].reason === 'wait_timeout', h.commits[0].reason);
}

sec('[3] 用户打断 → 旧 taskId 作废，已说上下文不动');
{
    const h = makeHarness();
    h.push('这句话说到一半');
    const oldId = h.s.currentTaskId();
    const before = h.commits.length;
    const ret = h.s.interrupt('barge_in');
    ck('打断后状态回 idle', h.s.state === STATE.IDLE, h.s.state);
    ck('打断后未提交的内容被丢弃（不抢答）', h.commits.length === before,
        String(h.commits.length));
    ck('打断后 taskId 递增（旧 ID 作废）', ret.taskId > oldId,
        `${oldId} → ${ret.taskId}`);
    ck('打断返回 discarded=true', ret.discarded === true);

    const { EnhancedTextProcessor } = require(path.join(__dirname, '..', 'js', 'tts-processor.js'));
    const p = Object.create(EnhancedTextProcessor.prototype);
    p.llmFullResponse = 'I already said this.';
    p._spokenText = 'I already said this.';
    p._completedSegments = ['I already said this.'];
    p._spokenOffset = 20;
    p.currentAudio = null;
    p.currentSegmentText = 'in progress';
    p.textSegmentQueue = [{ text: 'queued' }];
    p.audioDataQueue = [{ text: 'audio' }];
    p.syncTextQueue = [];
    p.pendingSegment = '';
    p._sentenceBuf = '';
    p._segToken = 0;
    p._ttsEpoch = 0;
    p._ttsSeq = 0;
    p._pendingAudios = new Map();
    p._subRAF = null; p._fillRAF = null; p._fillGen = 0;
    p.onAudioDataCallback = null;
    p.stopAudioOnly();
    ck('打断后 TTS 已说上下文保留', p._spokenText === 'I already said this.'
        && p._completedSegments.length === 1 && p._spokenOffset === 20,
        JSON.stringify({ spoken: p._spokenText, segs: p._completedSegments, off: p._spokenOffset }));
    ck('打断后待播队列被清空', p.textSegmentQueue.length === 0 && p.audioDataQueue.length === 0);

    h.s.finishAnswer();
    h.push('现在说新的话题');
    h.advance(COMMIT_HOLD_MS + 50);
    ck('打断后新一轮正常提交', h.commits.length === 1, String(h.commits.length));
    ck('新一轮不含旧会话的半句', !h.commits[0].text.includes('这句话说到一半'), h.commits[0].text);
    ck('新一轮 taskId 与旧的都不同', h.commits[0].taskId !== oldId,
        `${oldId} / ${h.commits[0].taskId}`);
}

sec('[4] 旧音频残留 → 过期 taskId 的段被丢弃');
{
    const h = makeHarness();
    h.push('第一段');
    const staleId = h.s.currentTaskId();
    const r = h.push('这段来自旧会话的迟到音频', { taskId: staleId - 1 });
    ck('过期 taskId 的段被拒绝', r.accepted === false && r.reason === 'stale_task_id',
        JSON.stringify(r));
    ck('过期段没有污染合并结果', !h.s.text.includes('迟到音频'), h.s.text);
    ck('droppedStale 计数 +1', h.s.droppedStale === 1, String(h.s.droppedStale));
    h.push('第二段');
    h.advance(COMMIT_HOLD_MS + 50);
    ck('提交内容只含有效段', h.commits[0].text.includes('第一段')
        && h.commits[0].text.includes('第二段')
        && !h.commits[0].text.includes('迟到音频'), h.commits[0].text);
}
{
    // 插话例外：即使带着旧 taskId，也不能丢（打断必须生效）
    const h = makeHarness();
    h.push('她在说话时我插一句', { duringTts: true });
    ck('插话立即提交（不被合并窗口吃掉）', h.commits.length === 1,
        JSON.stringify(h.commits.map(c => c.text)));
    ck('插话原因 = barge_in', h.commits[0].reason === 'barge_in', h.commits[0].reason);
    ck('插话带 duringTts 穿透能力', h.commits[0].taskId > 0);
}

sec('[5] 状态迁移合法性 + 明确标记与任务ID');
{
    const h = makeHarness();
    ck('初始 idle', h.s.state === STATE.IDLE);
    ck('初始 taskId = 0', h.s.taskId === 0);
    h.push('开始');
    const snap = h.s.snapshot();
    ck('snapshot 含 state/taskId/deadlineAt/segments',
        ['state','taskId','deadlineAt','segmentCount'].every(k => k in snap),
        JSON.stringify(Object.keys(snap)));
    ck('迁移记录非空（状态之间有明确标记）', snap.transitions.length > 0,
        String(snap.transitions.length));
    ck('所有迁移都是合法的', snap.transitions.every(t => t.ok),
        JSON.stringify(snap.transitions.filter(t => !t.ok)));
    // 非法迁移：idle 不能跳 answering
    const s2 = new UserTurnSession({ now: () => 1000 });
    ck('idle → answering 被拒绝', s2._to(STATE.ANSWERING, 'illegal') === false);
    ck('被拒后状态没变', s2.state === STATE.IDLE, s2.state);
    ck('拒绝也留痕', s2.snapshot().transitions.some(t => !t.ok));
}
{
    const h = makeHarness();
    const ids = [];
    for (let round = 0; round < 3; round++) {
        h.push('第' + round + '轮');
        h.advance(COMMIT_HOLD_MS + 50);
        ids.push(h.commits[h.commits.length - 1].taskId);
        h.s.finishAnswer();
    }
    ck('三轮提交各一次', h.commits.length === 3, String(h.commits.length));
    ck('taskId 单调递增且不重复', ids[0] < ids[1] && ids[1] < ids[2], JSON.stringify(ids));
}

sec('[6] 工具函数与中英文合并语义');
{
    ck('中文合并不加空格', joinUtterances('我想问', '一个问题') === '我想问一个问题',
        joinUtterances('我想问', '一个问题'));
    ck('英文合并加空格', joinUtterances('I want', 'to ask') === 'I want to ask',
        joinUtterances('I want', 'to ask'));
    ck('去掉悬空句末标点', joinUtterances('First part.', 'second part') === 'First part second part',
        joinUtterances('First part.', 'second part'));
    ck('空输入安全', joinUtterances('', 'abc') === 'abc' && joinUtterances('abc', '') === 'abc');
    ck('isWaitCue: 等一下', isWaitCue('等一下') && isWaitCue('let me think'));
    ck('isWaitCue: 普通句不误判', !isWaitCue('这个问题我想问一下'));
    ck('isFastFinish: 好的 / ok', isFastFinish('好的') && isFastFinish('ok'));
    ck('isFastFinish: 正常句不误判', !isFastFinish('I want to ask something'));
    ck('looksComplete: 句末标点', looksComplete('It is done.'));
    ck('looksComplete: 连接词结尾未完', !looksComplete('I was thinking and'));
}
{
    // 零延迟快速路径（ADR-001）：明确说完的短答立即提交
    const h = makeHarness();
    const r = h.push('好的');
    ck('短答零延迟立即提交', r.committed === true && h.commits.length === 1, JSON.stringify(r));
    ck('原因 = fast_finish', h.commits[0].reason === 'fast_finish', h.commits[0].reason);
}

sec('[7] taskId 错位回归：第 2/3 轮 TTS 文本不再被丢弃');
{
    const { EnhancedTextProcessor } = require(path.join(__dirname, '..', 'js', 'tts-processor.js'));
    const p = new EnhancedTextProcessor('http://x', null, null, null, {});
    clearTimeout(p._procTimer); clearTimeout(p._playTimer);
    const perRound = [];
    let taskId = 0;
    for (let round = 1; round <= 3; round++) {
        taskId += 1;
        p.reset();
        p.startTurn(taskId);
        const turn = p._currentTurn;
        const text = `Round ${round} says hello. It keeps going.`;
        p.shouldStop = false;
        for (let i = 0; i < text.length; i += 6) {
            p.addStreamingText(text.slice(i, i + 6), turn);
        }
        p.finalizeStreamingText();
        perRound.push(p.textSegmentQueue.map(s => s.text).join(''));
        ck(`第 ${round} 轮 turn 与 TTS 一致`, turn === p._currentTurn, `${turn} vs ${p._currentTurn}`);
        ck(`第 ${round} 轮文本没被丢弃`, perRound[round - 1].includes(`Round ${round} says hello`),
            perRound[round - 1]);
    }
    ck('三轮文本互不相同（没有串轮）',
        perRound[0] !== perRound[1] && perRound[1] !== perRound[2], JSON.stringify(perRound));
}

console.log(`\n结果：${PASS} PASS / ${FAIL} FAIL`);
process.exit(FAIL ? 1 : 0);
