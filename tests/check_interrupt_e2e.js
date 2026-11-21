#!/usr/bin/env node
const { InterruptState, classifyInterruption } = require('../js/interrupt-manager.js');

let PASS = 0, FAIL = 0;
function ck(name, cond, detail = '') {
    if (cond) { PASS++; console.log(`  PASS  ${name}`); }
    else { FAIL++; console.log(`  FAIL  ${name}  ${detail}`); }
}

function scenario({ full, spokenOffset, userText, isSpeaking }) {
    const st = new InterruptState(1);
    st.appendGenerated(full);
    st.updateSpoken(full.slice(0, spokenOffset));
    st.phase = 'interrupted';
    const cls = classifyInterruption(userText, { isSpeaking });
    // 真实代码路径：有效打断才记入 userAdds；语气词也要记（会置 ackOnly）
    st.addUserInputSmart(userText);
    return { st, cls, prompt: st.buildResumePrompt() };
}

console.log('[1] 场景：她说到一半，用户插话纠正 → 续接（不重复已播）');
{
    const full = 'The moon is sixty, so twenty plus moon is eighty, and twenty plus twenty is eighteen';
    const { st, cls, prompt } = scenario({
        full, spokenOffset: 33, userText: 'no, forty is right', isSpeaking: true,
    });
    ck('判定为有效打断', cls.kind === 'interrupt', cls.reason);
    ck('已播部分正确', st.spoken === 'The moon is sixty, so twenty plus moon is eighty, and twenty pl'.slice(0, 33) || st.spoken.length === 33, `${st.spoken.length}`);
    ck('续接提示不含完整已播内容（只给锚点，避免复述）',
        !prompt.includes('so twenty plus moon is eighty'), prompt.slice(0, 240));
    ck('续接提示含已播开头锚点', prompt.includes('The moon is sixty'), prompt.slice(0, 240));
    ck('续接提示含未说完的部分', prompt.includes('eighteen') || prompt.includes('plus twenty is eighteen'), prompt.slice(0, 260));
    ck('续接提示含用户补充', prompt.includes('forty is right'));
    ck('要求不要重复', /do NOT repeat/i.test(prompt));
}

console.log('\n[2] 场景：她正在说，用户只是"嗯" → 不打断');
{
    const { cls, st } = scenario({
        full: 'I was explaining the whole thing', spokenOffset: 10,
        userText: 'hmm', isSpeaking: true,
    });
    ck('判定为语气词', cls.kind === 'ack', cls.reason);
    ck('语气词不进 userAdds', st.mergedUserAdds() === '', st.mergedUserAdds());
    ck('标记了 ackOnly', st.ackOnly === true, `ackOnly=${st.ackOnly}`);
}

console.log('\n[3] 场景：连续两次打断，状态不混淆');
{
    const st = new InterruptState(1);
    st.appendGenerated('First answer that was interrupted halfway through');
    st.updateSpoken('First answer that was');
    st.phase = 'interrupted';
    st.addUserInputSmart('actually use the D drive');

    const st2 = new InterruptState(2);
    st2.spoken = st.spoken;
    st2.generated = st.generated;
    st2.unspoken = st.unspoken;
    st2.baseUserText = 'actually use the D drive';
    st2.phase = 'streaming';
    st2.appendGenerated('Second answer starts here');
    st2.updateSpoken('Second answer starts');
    st2.phase = 'interrupted';
    st2.addUserInputSmart('wait, actually no');

    const p2 = st2.buildResumePrompt();
    ck('第二轮只含第二轮的补充', p2.includes('wait, actually no'), p2.slice(0, 260));
    ck('第二轮不含第一轮的补充', !p2.includes('D drive'), p2.slice(0, 300));
    ck('第二轮已播正确', st2.spoken === 'Second answer starts', st2.spoken);
}

console.log('\n[4] 场景：她还没说完就被打断，且用户内容与原话题无关 → 提示要"改按新信息答"');
{
    const { prompt } = scenario({
        full: 'I was talking about the fan noise and the spectral subtraction',
        spokenOffset: 20, userText: 'switch topic, how do I fix my notes app',
        isSpeaking: true,
    });
    ck('含"没改变原意→续说完"分支', /\(A\)/.test(prompt) && /FINISH the sentence/i.test(prompt), prompt.slice(0, 300));
    ck('含"改变方向→说新内容"分支', /\(B\)/.test(prompt) && /say something NEW/i.test(prompt), prompt.slice(0, 300));
}

console.log('\n[5] 场景：已播放全部说完 → 不该产生重复');
{
    const full = 'Short complete answer.';
    const st = new InterruptState(1);
    st.appendGenerated(full);
    st.updateSpoken(full);
    st.phase = 'interrupted';
    st.addUserInputSmart('and also check the logs');
    const prompt = st.buildResumePrompt();
    ck('已播=全文', st.spoken === full);
    ck('未播为空', st.unspoken === '', JSON.stringify(st.unspoken));
    ck('提示不含"继续未说完"（因为没有未说完的）', !prompt.includes('about to continue'), prompt.slice(0, 240));
    ck('但仍带用户补充', prompt.includes('check the logs'));
}

console.log('\n[6] 场景：她没在说话时用户说话 → 不触发续接');
{
    const cls = classifyInterruption('hello there', { isSpeaking: false });
    ck('判定为非打断', cls.kind === 'none', cls.reason);
}

console.log(`\n结果：${PASS} PASS / ${FAIL} FAIL`);
process.exit(FAIL === 0 ? 0 : 1);
