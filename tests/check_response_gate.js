const { evaluateResponseGate, DEFAULTS } = require('../js/response-gate.js');

let pass = 0, fail = 0;
function ck(name, ok, extra) {
    if (ok) pass++; else fail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n         ' + extra}`);
}

const NOW = 1e12;
const rngHi = () => 0.99;
const rngLo = () => 0.01;

console.log('=== 回答门控 ===\n');

let r = evaluateResponseGate('Neuro, are you there?', { now: NOW, rng: rngHi });
ck('喊名字+问句 → 必答', r.decision === 'answer' && r.score >= 0.85, JSON.stringify(r));

r = evaluateResponseGate('嗯嗯', { now: NOW, rng: rngLo });
ck('纯语气词 → 沉默', r.decision === 'ignore' && r.score <= 0.12, JSON.stringify(r));

const monologue = 'so then we just drove around for twenty minutes before finally finding a parking spot near the old bridge and the traffic was insane the whole way there';
r = evaluateResponseGate(monologue, { now: NOW, rng: rngHi });
ck('长独白 → 像自言自语（降分）', r.reasons.some(x => x.includes('自言自语')), JSON.stringify(r.reasons));
ck('长独白 + 掷骰不中 + react开 → 听见了但不理', r.decision === 'react', r.decision);
r = evaluateResponseGate(monologue, { now: NOW, rng: rngHi, config: { react: false } });
ck('长独白 + 掷骰不中 + react关 → 沉默', r.decision === 'ignore', r.decision);
// react 分支不能泄漏到「掷骰命中」：低分位 rng 下仍要答
r = evaluateResponseGate(monologue, { now: NOW, rng: rngLo });
ck('长独白 + 掷骰命中 → 答', r.decision === 'answer', r.decision);

r = evaluateResponseGate('What time is it?', { now: NOW, rng: rngHi });
ck('普通问句 → 必答', r.decision === 'answer', JSON.stringify(r));

r = evaluateResponseGate('nice weather today', { now: NOW, lastReplyAt: NOW - 2000, rng: rngHi });
ck('冷却期内闲聊 → 有冷却惩罚', r.reasons.some(x => x.includes('才说完')), JSON.stringify(r.reasons));

r = evaluateResponseGate('hmm interesting', { now: NOW, busy: true, rng: rngHi });
ck('她正忙着 → 有忙碌惩罚', r.reasons.some(x => x.includes('她正说着')), JSON.stringify(r.reasons));

// 7) 喊名可以穿透冷却和忙碌（你叫她她必须听见）
r = evaluateResponseGate('hey neuro wait', { now: NOW, busy: true, lastReplyAt: NOW - 1000, rng: rngHi });
ck('喊名穿透冷却+忙碌 → 必答', r.decision === 'answer', JSON.stringify(r));

const a = evaluateResponseGate('maybe', { now: NOW, rng: () => 0.5 });
const b = evaluateResponseGate('maybe', { now: NOW, rng: () => 0.5 });
ck('确定性（同输入同输出）', JSON.stringify(a) === JSON.stringify(b));

r = evaluateResponseGate('just chatting here', { now: NOW, rng: rngLo, config: { rate: 0 } });
ck('rate=0 覆盖 → 必沉默', r.decision === 'ignore', JSON.stringify(r));

ck('DEFAULTS.react = true', DEFAULTS.react === true);
ck('DEFAULTS.cooldown_s = 12', DEFAULTS.cooldown_s === 12);

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
