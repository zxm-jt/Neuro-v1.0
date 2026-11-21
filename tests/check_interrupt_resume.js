// 用 Object.create(原型) 取实例方法，避免触发重量级构造函数（electron/音频）。
const { VoiceChatInterface } = require('../js/voice-chat.js');

let PASS = 0, FAIL = 0;
function ck(name, cond, extra) {
    if (cond) { PASS++; console.log('  PASS  ' + name); }
    else { FAIL++; console.log('  FAIL  ' + name + (extra ? '\n    ' + extra : '')); }
}

function makeFake(overrides) {
    const v = Object.create(VoiceChatInterface.prototype);
    v._bargeHint = 0; v._pendingResume = null; v._resumeTimer = null;
    v._skipEchoOnce = false; v._interruptState = null; v._lastInterrupt = null;
    v._aborted = false; v._lastReplyAt = 0;
    Object.assign(v, overrides || {});
    return v;
}

console.log('\n[A] _isPermanentStop（停语识别）');
{
    const v = makeFake();
    ck('等一下', v._isPermanentStop('等一下'));
    ck('我想想', v._isPermanentStop('我想想'));
    ck('稍等一下', v._isPermanentStop('稍等一下'));
    ck('先别', v._isPermanentStop('先别说了'));
    ck('hold on', v._isPermanentStop('hold on'));
    ck('let me think', v._isPermanentStop('let me think'));
    ck('wait.（短句）', v._isPermanentStop('wait.'));
    ck('否定式 i can\'t wait 不应停', !v._isPermanentStop("i can't wait"));
    ck('否定式 don\'t stop 不应停', !v._isPermanentStop("don't stop"));
    ck('普通问句不应停', !v._isPermanentStop('what time is it'));
    ck('你累了吗 不应停', !v._isPermanentStop('你累了吗'));
    ck('长句含 wait 不应停（wait, what time is it?）', !v._isPermanentStop('wait, what time is it?'));
}

console.log('\n[B] _getUnspokenText（取未说内容）');
{
    const v = makeFake({ _interruptState: { boundary: { unplayedText: ' the rest of it ' } } });
    ck('优先取 boundary.unplayedText', v._getUnspokenText() === 'the rest of it');
    const v2 = makeFake({ _interruptState: { unspoken: '  fallback unspoken ' } });
    ck('boundary 缺失时取 unspoken', v2._getUnspokenText() === 'fallback unspoken');
    const v3 = makeFake({ _interruptState: null });
    ck('无状态返回空串', v3._getUnspokenText() === '');
}

console.log('\n[C] 续说状态机 _scheduleResume / _cancelResume / _fireResume');
{
    const played = [];
    const v = makeFake({
        ttsProcessor: { processTextToSpeech: (t) => played.push(t), reset() {} },
        _interruptState: { boundary: { unplayedText: 'continue this thought' } },
    });
    v._scheduleResume('continue this thought', 'user said');
    ck('schedule 后 _pendingResume 存在', !!v._pendingResume);
    ck('schedule 后 _resumeTimer 存在', !!v._resumeTimer);
    v._cancelResume();
    ck('cancel 后 _pendingResume 清空', v._pendingResume === null);
    ck('cancel 后 _resumeTimer 清空', v._resumeTimer === null);

    v._scheduleResume('continue this thought', 'user said');
    v._fireResume();
    v._cancelResume();   // 清掉真实 timer，避免进程挂起
    ck('fire 后继续播放未说内容', played.length === 1 && played[0] === 'continue this thought');
    ck('fire 后 _pendingResume 清空', v._pendingResume === null);
    ck('fire 后 _interruptState 清空', v._interruptState === null);
    ck('fire 后 _aborted 复位', v._aborted === false);

    const v2 = makeFake({ ttsProcessor: { processTextToSpeech: () => { v2.__called = true; } } });
    v2._scheduleResume('   ', 'x'); v2._fireResume(); v2._cancelResume();
    ck('空白未说内容不触发播放', v2.__called !== true);
}

console.log(`\n结果：${PASS} PASS / ${FAIL} FAIL`);
process.exit(FAIL ? 1 : 0);
