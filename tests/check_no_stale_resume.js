#!/usr/bin/env node
'use strict';
const { VoiceChatInterface } = require('../js/voice-chat.js');
const { InterruptState } = require('../js/interrupt-manager.js');

let PASS = 0, FAIL = 0;
function ck(name, cond, extra = '') {
    if (cond) { PASS++; console.log('  PASS  ' + name); }
    else { FAIL++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}

function fake(overrides) {
    const v = Object.create(VoiceChatInterface.prototype);
    v._turnWasInterrupted = false;
    v._lastInterrupt = null;
    v._interruptState = null;
    v.ttsProcessor = null;
    Object.assign(v, overrides || {});
    return v;
}

function staleState() {
    const st = new InterruptState(1);
    st.spoken = 'Well, that went smoother than I thought! I can\'t help but feel a bit proud of my little coding victory.';
    st.generated = st.spoken;
    st.phase = 'interrupted';
    st.boundary = {
        completedSegments: [st.spoken],
        completedText: st.spoken,
        currentSegment: '',
        currentPartial: '',
        unplayedText: '',
    };
    return st;
}

console.log('[1] 她没在说话 → 即使残留着上一句完整边界，也绝不续接');
{
    const v = fake({ _interruptState: staleState() });
    ck('不生成续接提示', v._buildResumePromptIfNeeded() === null);
}

console.log('\n[2] 她正在说、但整句已播完、用户也没改方向 → 不续接');
{
    const v = fake({ _turnWasInterrupted: true, _interruptState: staleState() });
    ck('不生成续接提示', v._buildResumePromptIfNeeded() === null);
}

console.log('\n[3] 标记一次性消费：文本输入直接调 sendToLLM 不会带上轮打断');
{
    const st = staleState();
    st.unspoken = 'and the rest of it is still unplayed';
    const v = fake({ _turnWasInterrupted: true, _interruptState: st });
    ck('第一次拿到续接提示', typeof v._buildResumePromptIfNeeded() === 'string');
    ck('第二次返回 null', v._buildResumePromptIfNeeded() === null);
}

console.log('\n[4] 真打断（还有没播的部分）→ 提示存在且不含上一句全文');
{
    const st = staleState();
    st.boundary.unplayedText = 'and the rest of it is still unplayed';
    const v = fake({ _turnWasInterrupted: true, _interruptState: st });
    const p = v._buildResumePromptIfNeeded() || '';
    ck('生成续接提示', p.length > 0);
    ck('不把已播完整句原文列出来', !p.includes('Well, that went smoother'));
    ck('保留未播内容', p.includes('the rest of it is still unplayed'));
}

console.log('\n[5] _captureInterrupt：没在说话时不抓边界');
{
    const v = fake({
        ttsProcessor: {
            getInterruptBoundary: () => ({
                full: 'Well, that went smoother than I thought!',
                heard: 'Well, that went smoother than I thought!',
                missed: '',
            }),
        },
    });
    v._captureInterrupt();
    ck('_lastInterrupt 仍为 null', v._lastInterrupt === null);
}

console.log('\n[6] _captureInterrupt：正在说且有漏听 → 才记录边界');
{
    const v = fake({
        _turnWasInterrupted: true,
        ttsProcessor: {
            getInterruptBoundary: () => ({ full: 'one two three', heard: 'one', missed: ' two three' }),
        },
    });
    v._captureInterrupt();
    ck('_lastInterrupt.missed 有效', !!(v._lastInterrupt && v._lastInterrupt.missed.trim()));
}

console.log(`\n结果：${PASS} PASS / ${FAIL} FAIL`);
process.exit(FAIL === 0 ? 0 : 1);
