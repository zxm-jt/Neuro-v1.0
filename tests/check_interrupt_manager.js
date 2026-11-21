#!/usr/bin/env node
const { InterruptState, classifyInterruption, splitAckAndContent } = require('../js/interrupt-manager.js');

let PASS = 0, FAIL = 0;
function ck(name, cond, detail = '') {
    if (cond) { PASS++; console.log(`  PASS  ${name}`); }
    else { FAIL++; console.log(`  FAIL  ${name}  ${detail}`); }
}
const speaking = { isSpeaking: true };

console.log('[1] 语气词 → 不打断（ack）');
for (const t of ['oh', 'hmm', 'yeah', 'uh-huh', 'ok', 'mm', 'yep', '嗯', '哦', '对', '好的']) {
    const r = classifyInterruption(t, speaking);
    ck(`「${t}」不打断`, r.kind === 'ack', `实际 ${r.kind}（${r.reason}）`);
}

console.log('\n[2] 有实质内容 → 有效打断（interrupt）');
for (const t of [
    'wait, actually I meant the other folder',
    'no, use the D drive instead',
    '帮我打开一下D盘的GAME文件夹',
    'the moon is not sixty, I made that up',
    'stop, that is wrong',
    '换个话题，我想问火箭发动机',
]) {
    const r = classifyInterruption(t, speaking);
    ck(`「${t.slice(0, 26)}」打断`, r.kind === 'interrupt', `实际 ${r.kind}（${r.reason}）`);
}

console.log('\n[3] 语气词 + 实质内容 → 打断（不是纯反馈）');
for (const t of ['hmm wait no that is wrong', '嗯，其实我想说的是另一个', 'ok but use the other one']) {
    const r = classifyInterruption(t, speaking);
    ck(`「${t.slice(0, 24)}」打断`, r.kind === 'interrupt', `实际 ${r.kind}（${r.reason}）`);
}

console.log('\n[4] 她没在说话 → 不算打断');
{
    const r = classifyInterruption('oh', { isSpeaking: false });
    ck('她没说话时「oh」不打断', r.kind === 'none', `实际 ${r.kind}`);
    const r2 = classifyInterruption('hello there', { isSpeaking: false });
    ck('她没说话时普通输入也不打断', r2.kind === 'none', `实际 ${r2.kind}`);
}

console.log('\n[5] 明确否定 → 即使短也要打断');
for (const t of ['不', '别', 'no', 'stop']) {
    const r = classifyInterruption(t, speaking);
    ck(`「${t}」打断`, r.kind === 'interrupt', `实际 ${r.kind}（${r.reason}）`);
}

console.log('\n[6] 拆分：语气词与实质内容分离');
{
    const a = splitAckAndContent('hmm wait no that is wrong');
    ck('ack 部分 = "hmm"', a.ack === 'hmm', JSON.stringify(a));
    ck('content 部分保留全文', a.content.includes('wait'), JSON.stringify(a.content));
    const b = splitAckAndContent('yeah');
    ck('纯语气词 → content 为空', b.content === '' && b.ack === 'yeah', JSON.stringify(b));
}

console.log('\n[7] InterruptState：已播/未播的切分');
{
    const st = new InterruptState(1);
    st.appendGenerated('Obviously user, the moon is sixty. ');
    st.appendGenerated('So twenty plus moon is eighty, right?');
    st.updateSpoken('Obviously user, the moon is sixty. ');
    ck('已播放 = 第一段', st.spoken.startsWith('Obviously'), st.spoken);
    ck('未播放 = 第二段', st.unspoken.includes('twenty plus moon'), JSON.stringify(st.unspoken));
    ck('已生成 = 全文', st.generated.length > st.spoken.length, `${st.generated.length}`);
}

console.log('\n[8] 续接提示包含关键三要素，且不含"从头说"');
{
    const st = new InterruptState(1);
    st.appendGenerated('The moon is sixty. So twenty plus moon is eighty.');
    st.updateSpoken('The moon is sixty. ');
    st.addUserInput('wait, actually forty is right');
    const p = st.buildResumePrompt();
    ck('含已说过的内容', p.includes('The moon is sixty.'), p.slice(0, 120));
    ck('含未说完的想法', p.includes('twenty plus moon'), p.slice(0, 200));
    ck('含用户补充', p.includes('forty is right'), p.slice(0, 240));
    ck('明确要求不要重复', /do NOT repeat/i.test(p));
    ck('明确要求不要从头开始', /do not start over|do NOT restart/i.test(p));
}

console.log('\n[9] 纯语气词打断 → 提示她自然继续');
{
    const st = new InterruptState(2);
    st.appendGenerated('I was going to explain the whole thing but');
    st.updateSpoken('I was going to explain the whole thing ');
    st.addUserInputSmart('hmm');
    const p = st.buildResumePrompt();
    ck('识别为反馈而非新请求', /brief sound|feedback/i.test(p), p.slice(-200));
    ck('要求接着说', /continue the sentence\/thought/i.test(p), p.slice(-200));
}

console.log('\n[10] 连续多轮打断 → 内容不混淆');
{
    const st = new InterruptState(3);
    st.addUserInput('first addition');
    st.addUserInput('second addition');
    const m = st.mergedUserAdds();
    ck('两条补充都保留', m.includes('first addition') && m.includes('second addition'), m);
}

console.log(`\n结果：${PASS} PASS / ${FAIL} FAIL`);
process.exit(FAIL === 0 ? 0 : 1);
