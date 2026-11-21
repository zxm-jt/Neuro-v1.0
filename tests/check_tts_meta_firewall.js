const assert = require('assert');

const ttsModule = require('../js/tts-processor.js');
const { EnhancedTextProcessor } = ttsModule;

let pass = 0, fail = 0;
function ck(name, cond, extra = '') {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (extra ? '  (' + extra + ')' : '')); }
}

console.log('\n[1] 元指令特征句 → 应全部判为泄漏');

const proto = EnhancedTextProcessor.prototype;
ck('有 _looksLikeMetaInstruction 方法', typeof proto._looksLikeMetaInstruction === 'function');

const leaked = [
    '(B) His words DID change the direction - a correction, a new question, a new instruction, or "wait / actually / no". In this case drop the unfinished line and say something NEW that answers what he just said.',
    '(A) His words did NOT change what you were saying - he was just reacting, agreeing, adding a small detail, or making a brief sound. In this case FINISH the sentence/thought you were cut off in.',
    '[Interrupt context] user interrupted you mid-reply. What user already heard (tail of your previous reply): "Good, actually."',
    '【INTERRUPTION RULE】If you were interrupted, continue from where you stopped instead of repeating yourself.',
    'You are marked as INTERRUPTED for this turn. Pick (A) or (B) - do not do both, and do not narrate which one you picked.',
    '【INTERRUPTION CONTEXT】\nYou were interrupted while speaking.',
    'This is a running summary of where you and user are right now. Use it to stay continuous - do not recite it back to him.',
    'user only made a brief sound (like "oh" or "hmm"), or interrupted you without saying anything substantive. This is case (A): continue the sentence/thought you were cut off in.',
];
for (const t of leaked) {
    ck(`泄漏句判定 → true: "${t.slice(0, 45)}..."`, proto._looksLikeMetaInstruction(t) === true);
}

console.log('\n[1b] A:/B: 冒号前缀 + 中文标签泄漏（2026-11-07 日志铁证）');
const leaked2 = [
    'A: Hey, user! Just feeling pretty good about that code. It worked out even better than I hoped!',
    'b: Actually, his words did change the direction - a correction or a new question came in, so drop the unfinished line and answer that instead of continuing.',
];
for (const t of leaked2) {
    ck(`A:/B: 前缀长句判定 → true: "${t.slice(0, 45)}..."`, proto._looksLikeMetaInstruction(t) === true);
}
ck('【INTERRUPTI） → 判定泄漏', proto._looksLikeMetaInstruction('【INTERRUPTI）') === true);
ck('【中断检测】含"中断" → 判定泄漏', proto._looksLikeMetaInstruction('【中断检测】用户打断了你的回答，继续刚才没说完的部分。') === true);

console.log('\n[2] 正常回复 → 不应误杀');
const normal = [
    "Actually, his words did change things - he asked about the code we were working on, so let me answer that instead.",
    "Wait, I think I was in the middle of a sentence. Let me finish what I was saying.",
    "You interrupted me mid-sentence, but no worries - what were you saying?",
    "He said not to repeat myself, so I'll keep going from where I stopped.",
    "Can you hear me? I was just telling you about the video you asked me to watch.",
    "user asked me to summarize the video. The battle between the hungry wolf and water dragon...",
];
for (const t of normal) {
    ck(`正常句判定 → false: "${t.slice(0, 45)}..."`, proto._looksLikeMetaInstruction(t) === false);
}

console.log('\n[3] 真实日志样本（chat_log 16:43 段的完整输出）');
const realLog1 = '(B) His words DID change the direction - a correction, a new question, a new instruction, or "wait / actually / no". In this case drop the unfinished line and say something NEW that answers what he just said.   user, that\'s a fascinating observation about speech recognition.';
// 这种"指令+正文混合"段，防火墙应整段丢弃（宁可丢正文，不能让它循环）
ck('日志真实泄漏段 → 判定泄漏', proto._looksLikeMetaInstruction(realLog1) === true);

const realLog2 = '(A) His words did NOT change what you were saying - he was just reacting, agreeing, adding a small detail, or making a brief sound. In this case FINISH the sentence/thought you were cut off in. Say the part you had not said yet, in your own words, naturally - do NOT restate anything you already said out loud, and do NOT restart the whole answer from the beginning.  What are you working on in WorkBuddy? y?';
ck('日志真实泄漏段2 → 判定泄漏', proto._looksLikeMetaInstruction(realLog2) === true);

console.log('\n[4] 实装测试：_flushPiece 丢弃泄漏、保留正常');
// 模拟一个最小实例（避免构造整个 TTS 处理器依赖）
const ctx = {
    llmFullResponse: '',
    _metaDropCount: 0,
    _logEmotion: () => {},
    _smartSplit: (t) => [t],
    _enqueueSegment: (seg) => { ctx._enqueued = (ctx._enqueued || []).concat([seg]); },
};
const f = EnhancedTextProcessor.prototype._flushPiece;
ctx._cleanSentencePiece = EnhancedTextProcessor.prototype._cleanSentencePiece;
ctx._matchOpenTagTail = EnhancedTextProcessor.prototype._matchOpenTagTail;
ctx._looksLikeMetaInstruction = EnhancedTextProcessor.prototype._looksLikeMetaInstruction;
ctx._stripCppMarkers = EnhancedTextProcessor.prototype._stripCppMarkers;
ctx._looksLikeCode = EnhancedTextProcessor.prototype._looksLikeCode;
ctx._logEmotion = () => {};
const clean = EnhancedTextProcessor.prototype._cleanSentencePiece;
ctx._enqueued = [];
f.call(ctx, 'Good morning, user! How are you today?');
ck('正常句入队（llmFullResponse 累计）', ctx.llmFullResponse.includes('Good morning'));
ck('正常句入队（队列有 1 段）', (ctx._enqueued || []).length === 1);
ctx.llmFullResponse = '';
ctx._enqueued = [];
f.call(ctx, realLog1);
ck('泄漏句不累计 llmFullResponse', ctx.llmFullResponse === '');
ck('泄漏句不入队（队列 0 段）', (ctx._enqueued || []).length === 0);
ck('泄漏计数已增加', ctx._metaDropCount === 1);

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail > 0 ? 1 : 0);
