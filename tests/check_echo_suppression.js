const { _echoSim, _echoDecision } = require('../js/voice-chat.js');

function guardDrop(text, spoken, playing, tail, isBarge) {
    return _echoDecision(text, spoken, playing, tail, isBarge).drop;
}
// barge 完整链路：削前缀 → 空=丢 → 尾部 trigram → 否则放行
function guardDropBarge(text, spoken) {
    const { _stripSpokenEchoPrefix, _hasTrigramMatchTail } = require('../js/voice-chat.js');
    const cut = _stripSpokenEchoPrefix(text, spoken);
    const rest = cut.stripped > 0 ? cut.text : text;
    if (cut.stripped > 0 && !rest.trim()) return true;
    for (const s of spoken) {
        if (_hasTrigramMatchTail(rest, s)) return true;
    }
    return false;
}

let pass = 0, fail = 0;
function ck(name, cond, extra = '') {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (extra ? '  (' + extra + ')' : '')); }
}

console.log('\n[1] _echoSim：回声 vs 真实插话 的相似度区分');

const neuro1 = "Good, actually. Quiet in the way I like — I spent most of it poking at that code, " +
    "and now I'm insufferable about it, as promised.  What about you? " +
    "You've been drifting in and out all morning without saying much.";
const echoCmd2 = "I spent most of it poking at that code. And now I'm insufferable about it, as promised. " +
    "What about you, You've been drifting in and out all morning without saying much. You are very cute.";
const neuro2 = "You just repeated my whole sentence back at me. Is that a bit? Are we doing a bit now?" +
    "...and then you slipped the cute thing in at the end, like I wouldn't notice.";
const echoCmd3 = "You just repeated my whole sentence back at me. Is that a bit. Are we doing a bit now, " +
    "And then you slipped the cute thing in at the end, like I would' notice.";

ck('回显 cmd2 与 neuro1 高相似 (>0.6)', _echoSim(echoCmd2, neuro1) > 0.6, 'sim=' + _echoSim(echoCmd2, neuro1).toFixed(2));
ck('回显 cmd3 与 neuro2 极高相似 (>0.8)', _echoSim(echoCmd3, neuro2) > 0.8, 'sim=' + _echoSim(echoCmd3, neuro2).toFixed(2));

const bargeTexts = [
    "what did you mean by that",
    "stop",
    "hey are you even listening",
    "tell me about the code you were working on",
    "哈哈哈哈",
    "嗯，你今天过得怎么样",
];
let maxBargeSim = 0;
for (const b of bargeTexts) {
    maxBargeSim = Math.max(maxBargeSim, _echoSim(b, neuro1), _echoSim(b, neuro2));
}
ck('真实插话内容 vs 她的话 相似度 < 0.6（留余量）', maxBargeSim < 0.6, 'max=' + maxBargeSim.toFixed(2));
ck('用户逐字复述也判为回声 (>0.62)', _echoSim(neuro1, neuro1) > 0.62, 'sim=' + _echoSim(neuro1, neuro1).toFixed(2));

console.log('\n[2] 回声（非插话）在 播放/刚停/已停 三档都应丢弃');
ck('播放中回显 → drop=true', guardDrop(echoCmd2, [neuro1], true, 0, false) === true);
ck('刚停(500ms)回显 → drop=true', guardDrop(echoCmd3, [neuro2], false, 500, false) === true);
ck('已停(5s)回显 → drop=true', guardDrop(echoCmd3, [neuro2], false, 5000, false) === true);

console.log('\n[3] 插话（barge）不再用相似度判据：真插话全放行，逐字回声仍丢弃');
ck('插话场景不做相似度丢弃', _echoDecision('x', ['x'], true, 0, true).drop === false);
ck('非插话·播放中阈值 = 0.4', _echoDecision('x', ['x'], true, 0, false).th === 0.4);
const sharedWordBarges = [
    "what did you mean by that",
    "I'm tired, are you?",
    "Quiet inthe way I like? No wait, tell me about the code you were poking.",
];
for (const b of sharedWordBarges) {
    const sim = Math.max(_echoSim(b, neuro1), _echoSim(b, neuro2));
    ck('共用词插话放行 sim=' + sim.toFixed(2) + ' [barge链路]', guardDropBarge(b, [neuro1, neuro2]) === false);
    // 同一句若按非插话处理，播放中档会丢 —— 证明 barge 参数确实生效
    ck('  └ 同一句非插话时按 0.4 档丢弃', guardDrop(b, [neuro1, neuro2], true, 0, false) === true);
}
for (const b of bargeTexts) {
    ck('插话放行[barge链路]: "' + b.slice(0, 24) + '"', guardDropBarge(b, [neuro1, neuro2]) === false);
}
// 她的 TTS 余音被标成 duringTts 时仍需丢掉，否则又重复自己的话
for (const w of [0, 500, 5000]) {
    ck('插话通道里逐字回声[停' + w + 'ms]仍丢弃', guardDrop(neuro2, [neuro2], false, w, true) === true);
}
ck('barge尾部逐字回声仍丢弃', guardDropBarge("What about you? You've been drifting", [neuro1]) === true);

console.log('\n[4] 边界情形');
ck('首次发言(无历史) → 不丢', guardDrop("嗯，你今天过得怎么样", [], false, 9999, false) === false);
ck('仅含重叠词的不同内容 → 不丢', guardDrop("you are very cute", [neuro1], false, 5000, false) === false);

console.log('\n结果: ' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
