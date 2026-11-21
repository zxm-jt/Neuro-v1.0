const { synthesizeForSituation, CuteSoundPlayer, DEFAULTS } = require('../js/cute-sounds.js');

let pass = 0, fail = 0;
function ck(name, ok, extra) {
    if (ok) pass++; else fail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n         ' + extra}`);
}

function makeRng(seed) {
    let x = (seed >>> 0) || 1;
    return () => {
        x = (x * 1664525 + 1013904223) >>> 0;
        return x / 4294967296;
    };
}
const gen = (st, seed = 12345) => synthesizeForSituation(
    Object.assign({ random: makeRng(seed), timeOfDay: 12 }, st), {});

const SITUATIONS = {
    userPraise: {
        event: 'userPraise', emotion: { name: 'happy', intensity: 0.9 },
        valence: 0.8, arousal: 0.75, tension: 0.2,
        drives: { curiosity: 0.3, social: 0.8, rest: 0.1, order: 0.1, achievement: 0.7, boredom: 0.1 },
    },
    userCorrected: {
        event: 'userCorrected', emotion: { name: 'sad', intensity: 0.7 },
        valence: -0.6, arousal: 0.5, tension: 0.8,
        drives: { curiosity: 0.2, social: 0.3, rest: 0.2, order: 0.4, achievement: 0.2, boredom: 0.1 },
    },
    returned: {
        event: 'returned', emotion: { name: 'excited', intensity: 0.8 },
        valence: 0.6, arousal: 0.8, tension: 0.2, idleMs: 11 * 60000,
        drives: { curiosity: 0.5, social: 0.9, rest: 0.1, order: 0.1, achievement: 0.2, boredom: 0.1 },
    },
    discovered: {
        event: 'discovered', emotion: { name: 'curious', intensity: 0.85 },
        valence: 0.5, arousal: 0.75, tension: 0.35,
        drives: { curiosity: 0.95, social: 0.2, rest: 0.1, order: 0.1, achievement: 0.4, boredom: 0.1 },
    },
    sleepy: {
        event: 'sleepy', emotion: { name: 'calm', intensity: 0.6 },
        valence: -0.1, arousal: 0.2, tension: 0.1, timeOfDay: 23,
        drives: { curiosity: 0.1, social: 0.1, rest: 0.95, order: 0.2, achievement: 0.1, boredom: 0.5 },
    },
};

const slope = (g) => g.notes[g.notes.length - 1].f - g.notes[0].f;
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const fp = (g) => JSON.stringify(g.notes.map(n => [n.f, n.d]));

class FakeParam {
    constructor(v = 0) { this.value = v; }
    setValueAtTime(v) { this.value = v; return this; }
    linearRampToValueAtTime(v) { this.value = v; return this; }
    exponentialRampToValueAtTime(v) { this.value = v; return this; }
}
class FakeNode {
    connect() { return this; }
    start() {}
    stop() {}
}
class FakeAudioContext {
    constructor() {
        this.state = 'running'; this.currentTime = 0;
        this.sampleRate = 44100; this.destination = new FakeNode();
    }
    createGain() { return Object.assign(new FakeNode(), { gain: new FakeParam(1) }); }
    createOscillator() {
        return Object.assign(new FakeNode(), { type: 'sine', frequency: new FakeParam(440) });
    }
    createBuffer(ch, len) { const d = new Float32Array(len); return { getChannelData: () => d }; }
    createBufferSource() { return Object.assign(new FakeNode(), { buffer: null }); }
    resume() { this.state = 'running'; return Promise.resolve(); }
}
global.window = { AudioContext: FakeAudioContext };

console.log('=== 生成式音效 v3（情境 → 现场合成）===\n');

console.log('— (a) 不同情境 → 不同音符 —');
const G = {};
for (const k of Object.keys(SITUATIONS)) G[k] = gen(SITUATIONS[k], 777);
ck('五种情境都产生非空音符', Object.keys(G).every(k => G[k].notes.length >= 2),
   JSON.stringify(Object.keys(G).map(k => [k, G[k].notes.length])));
ck('五种情境音效指纹互不相同', new Set(Object.keys(G).map(k => fp(G[k]))).size === 5,
   JSON.stringify(Object.keys(G).map(k => [k, G[k].spec.dominant, G[k].spec.baseHz])));
ck('被夸 vs 困了：基频明显不同', G.userPraise.spec.baseHz - G.sleepy.spec.baseHz > 200,
   `praise=${G.userPraise.spec.baseHz} sleepy=${G.sleepy.spec.baseHz}`);
ck('被纠正：avoid 主导 + 骤降/气声',
   G.userCorrected.spec.dominant === 'avoid'
   && (G.userCorrected.spec.slideDown || G.userCorrected.spec.breathy),
   JSON.stringify(G.userCorrected.spec));
ck('探索新东西：explore 主导且上扬',
   G.discovered.spec.dominant === 'explore' && slope(G.discovered) > 0,
   `dominant=${G.discovered.spec.dominant} slope=${slope(G.discovered)}`);
ck('困了：rest 主导、音符偏慢',
   G.sleepy.spec.dominant === 'rest' && G.sleepy.notes[0].d >= 150,
   `dominant=${G.sleepy.spec.dominant} d0=${G.sleepy.notes[0].d}`);

console.log('\n— (b) 同族共性 / 逐次差异 —');
const s1 = gen(SITUATIONS.userPraise, 42), s2 = gen(SITUATIONS.userPraise, 42);
ck('确定性：同 seed 同输出', JSON.stringify(s1) === JSON.stringify(s2));
const s3 = gen(SITUATIONS.userPraise, 43);
ck('同情境不同 seed：音符不同但同族', s1.spec.dominant === s3.spec.dominant && fp(s1) !== fp(s3),
   `${s1.spec.dominant}/${s3.spec.dominant}`);

const sleepyMany = Array.from({ length: 12 }, (_, i) => gen(SITUATIONS.sleepy, 100 + i));
const discMany = Array.from({ length: 12 }, (_, i) => gen(SITUATIONS.discovered, 200 + i));
const corrMany = Array.from({ length: 12 }, (_, i) => gen(SITUATIONS.userCorrected, 300 + i));
ck('困了族：平均基频低、平均时长长',
   avg(sleepyMany.map(g => g.spec.baseHz)) < 400 && avg(sleepyMany.map(g => g.notes[0].d)) > 150,
   `f=${avg(sleepyMany.map(g => g.spec.baseHz)).toFixed(0)} d=${avg(sleepyMany.map(g => g.notes[0].d)).toFixed(0)}`);
ck('探索族：统计上整体上扬，且都 explore 主导',
   avg(discMany.map(slope)) > 0 && discMany.every(g => g.spec.dominant === 'explore'),
   `avgSlope=${avg(discMany.map(slope)).toFixed(1)}`);
ck('被纠正族：统计上整体下行且带骤降/气声',
   avg(corrMany.map(slope)) < 0
   && corrMany.every(g => g.spec.slideDown || g.spec.breathy),
   `avgSlope=${avg(corrMany.map(slope)).toFixed(1)}`);

console.log('\n— (c) 说话时绝对静默 —');
ck('synthesizeForSituation: speaking → null',
   synthesizeForSituation(Object.assign({ speaking: true }, SITUATIONS.userPraise, { random: makeRng(1) })) === null);
ck('长时间空闲也在说话 → 仍 null',
   synthesizeForSituation({ speaking: true, idleMs: 9e5, random: makeRng(1) }) === null);

// ---------- (d) 安全性 / 开关 ----------
console.log('\n— (d) 安全区间与开关 —');
ck('所有生成音符的频率/时长在安全区间',
   Object.keys(G).every(k => G[k].notes.every(n =>
       n.f >= 80 && n.f <= 4000 && n.d >= 40 && n.d <= 600)),
   JSON.stringify(Object.keys(G).map(k => [k, G[k].notes[0].f, G[k].notes[0].d])));
ck('生成式关闭 → synthesize 返回 null',
   synthesizeForSituation({ emotion: 'happy', random: makeRng(1) }, { generative_enabled: false }) === null);
const direct = new CuteSoundPlayer({ generative_enabled: true });
ck('playSituation 可现场合成并播放',
   direct.playSituation(Object.assign({ random: makeRng(9) }, SITUATIONS.discovered)) === true);
ck('playSituation 说话时不响',
   direct.playSituation({ speaking: true, random: makeRng(9) }) === false);
const legacy = new CuteSoundPlayer({ generative_enabled: false });
const lg = legacy.tickSituation(() => ({ speaking: false, justStarted: true, random: 0.99 }));
ck('generative_enabled=false 回落旧 tick（chirp）', lg.sound === 'chirp', JSON.stringify(lg));

console.log('\n— (e) 硬闸不被绕过 —');
const live = new CuteSoundPlayer({ enabled: true, generative_enabled: true,
    generative_chance: 1, cooldown_s: 45, volume: 0.05 });
const liveState = () => ({ speaking: false, idleMs: 0, random: 0.99,
    emotion: 'happy', drives: { curiosity: 0.8 }, timeOfDay: 12 });
const first = live.tickSituation(liveState);
ck('首次 tick 通过闸门并现场合成',
   first.play === true && first.sound === '__generative__' && first.spec.source === 'generative',
   JSON.stringify(first).slice(0, 220));
const second = live.tickSituation(liveState);
ck('紧接着再 tick → 普通冷却拦截', second.play === false && second.why.indexOf('冷却') >= 0,
   JSON.stringify(second));

const win = new CuteSoundPlayer({ enabled: true, generative_enabled: true,
    generative_chance: 1, max_per_10min: 6 });
win._started = true;
win.soundsInWindow = 6;
win.windowStartAt = Date.now();
win.lastSoundAt = Date.now() - 60000;   // 越过普通冷却，专测窗口上限
const wr = win.tickSituation(liveState);
ck('10 分钟窗口 6 次 → 不再出声', wr.play === false && wr.why.indexOf('次数用尽') >= 0,
   JSON.stringify(wr));

const wel = new CuteSoundPlayer({ enabled: true, generative_enabled: true,
    generative_chance: 1, welcome_cooldown_s: 120 });
wel.lastWelcomeAt = Date.now() - 30000;
const wr2 = wel.tickSituation(() => ({ speaking: false, idleMs: 11 * 60000, random: 0.99 }));
ck('welcome 独立冷却未被绕过', wr2.play === false && wr2.why.indexOf('welcome') >= 0,
   JSON.stringify(wr2));

const mute = new CuteSoundPlayer({ enabled: true, generative_enabled: true, generative_chance: 1 });
const mr = mute.tickSituation(() => ({ speaking: true, idleMs: 0, random: 0.01 }));
ck('tickSituation 说话时不出声', mr.play === false, JSON.stringify(mr));

ck('DEFAULTS.generative_enabled 默认 true', DEFAULTS.generative_enabled === true);

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
