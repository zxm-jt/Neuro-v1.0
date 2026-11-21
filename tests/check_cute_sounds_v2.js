const {
    SOUNDS, DEFAULTS, EMOTION_SOUNDS, INTENT_SOUNDS,
    decideCuteSound, compileSpec,
} = require('../js/cute-sounds.js');

let pass = 0, fail = 0;
function ck(name, ok, extra) {
    if (ok) pass++; else fail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n         ' + extra}`);
}

const NOW = 1e12;
const T = (over) => Object.assign({
    now: NOW, speaking: false, idleMs: 0, justStarted: false,
    lastSoundAt: 0, lastWelcomeAt: 0, lastExpressiveAt: 0,
    soundsInWindow: 0, windowStartAt: NOW - 1000, random: 0.99,
}, over);

console.log('=== 扩展音效：自制音效 + 自主联动 ===\n');

console.log('— 自制音效 compileSpec —');
const up = compileSpec({ mood: 'happy', contour: 'up', pitch: 'mid', tempo: 'fast', length: 'short' });
const down = compileSpec({ mood: 'sad', contour: 'down', pitch: 'mid', tempo: 'slow', length: 'long' });
ck('上扬音阶：末音高于首音', up.length >= 2 && up[up.length - 1].f > up[0].f, JSON.stringify(up));
ck('下行音阶：末音低于首音', down.length >= 2 && down[down.length - 1].f < down[0].f, JSON.stringify(down));
ck('length=long 音符更多', down.length > up.length, `${up.length} vs ${down.length}`);
ck('tempo=fast 时长更短', up[0].d < down[0].d, `${up[0].d} vs ${down[0].d}`);
const hi = compileSpec({ pitch: 'high' }), lo = compileSpec({ pitch: 'low' });
ck('pitch=high 基频更高', hi[0].f > lo[0].f, `${hi[0].f} vs ${lo[0].f}`);
ck('波形音色生效', compileSpec({ timbre: 'square' })[0].type === 'square');
ck('flat 走向：所有音同频', (() => { const f = compileSpec({ contour: 'flat', length: 'long' }); return f.every(n => n.f === f[0].f); })());
ck('音符频率/时长在安全区间', (() => {
    for (const n of [...up, ...down, ...hi, ...lo]) {
        if (!(n.f >= 80 && n.f <= 4000)) return false;
        if (!(n.d >= 40 && n.d <= 600)) return false;
    }
    return true;
})());
ck('空 spec 有合理默认', compileSpec().length >= 1);
ck('确定性：同 spec 同输出', JSON.stringify(compileSpec({ mood: 'curious' })) === JSON.stringify(compileSpec({ mood: 'curious' })));

console.log('\n— 扩展音效库 —');
const newNames = ['happy', 'sad', 'surprised', 'sigh', 'pout', 'excited', 'purr', 'idea', 'fanfare', 'retreat'];
let libOk = true;
for (const name of newNames) {
    if (!Array.isArray(SOUNDS[name]) || !SOUNDS[name].length) { libOk = false; break; }
}
ck('新增音效均有定义（10+ 种）', libOk && Object.keys(SOUNDS).length >= 20, `共 ${Object.keys(SOUNDS).length} 种`);
ck('噪声/滑音/颤音音符字段被定义', !!(SOUNDS.sneeze.some(n => n.noise) && SOUNDS.pout.some(n => n.slide) && SOUNDS.purr.some(n => n.vib)));
ck('情绪映射表覆盖六类', ['happy', 'sad', 'surprised', 'shy', 'angry', 'neutral'].every(e => EMOTION_SOUNDS[e]));
ck('意图映射表对齐 intent.py 六类', ['exploratory', 'social', 'mastery', 'order', 'restful', 'avoidant'].every(i => INTENT_SOUNDS[i]));
ck('映射表引用的音效都存在', (() => {
    for (const pool of [...Object.values(EMOTION_SOUNDS), ...Object.values(INTENT_SOUNDS)])
        for (const s of pool) if (!SOUNDS[s]) return false;
    return true;
})());

console.log('\n— 情绪/意图自主联动（默认关闭，显式开启）—');
const EXP = { emotion_enabled: true, intent_enabled: true, expressive_cooldown_s: 50 };
let d = decideCuteSound(T({ emotion: 'happy' }), {});
ck('默认关闭：有情绪也不响', d.play === false, JSON.stringify(d));
d = decideCuteSound(T({ emotion: 'happy' }), EXP);
ck('开启后：情绪 happy → 出声', d.play === true && d.why.indexOf('情绪') >= 0, JSON.stringify(d));
ck('情绪音效来自 happy 池', EMOTION_SOUNDS.happy.includes(d.sound), d.sound);
d = decideCuteSound(T({ intent: 'restful', emotion: 'happy' }), EXP);
ck('意图优先于情绪', d.play === true && d.why.indexOf('意图') >= 0, JSON.stringify(d));
ck('意图音效来自 restful 池', INTENT_SOUNDS.restful.includes(d.sound), d.sound);
d = decideCuteSound(T({ intent: 'mastery' }), EXP);
ck('意图 mastery → 成就池', INTENT_SOUNDS.mastery.includes(d.sound), d.sound);
d = decideCuteSound(T({ emotion: 'happy', speaking: true }), EXP);
ck('说话时绝对安静（优先级最高）', d.play === false, JSON.stringify(d));
d = decideCuteSound(T({ emotion: 'happy', lastExpressiveAt: NOW - 20000 }), EXP);
ck('表情音额外冷却生效', d.play === false, JSON.stringify(d));
d = decideCuteSound(T({ emotion: 'happy', lastExpressiveAt: NOW - 60000 }), EXP);
ck('表情音冷却过后可再响', d.play === true, JSON.stringify(d));
d = decideCuteSound(T({ emotion: 'happy', lastSoundAt: NOW - 10000 }), EXP);
ck('普通冷却仍生效（表情音也吃冷却）', d.play === false, JSON.stringify(d));
d = decideCuteSound(T({ emotion: 'unknown_emotion' }), EXP);
ck('未知情绪回落：不误响', d.play === false, JSON.stringify(d));

console.log('\n— 边界 —');
ck('DEFAULTS 新增开关默认 false', DEFAULTS.emotion_enabled === false && DEFAULTS.intent_enabled === false);
ck('原有 welcome/chirp 未被破坏', (() => {
    const w = decideCuteSound(T({ idleMs: 11 * 60000 }), {});
    const c = decideCuteSound(T({ justStarted: true }), {});
    return w.sound === 'welcome' && c.sound === 'chirp';
})());

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
