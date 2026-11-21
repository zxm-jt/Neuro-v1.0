const { decideCuteSound, DEFAULTS, SOUNDS } = require('../js/cute-sounds.js');

let pass = 0, fail = 0;
function ck(name, ok, extra) {
    if (ok) pass++; else fail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n         ' + extra}`);
}

const NOW = 1e12;
const T = (over) => Object.assign({
    now: NOW, speaking: false, idleMs: 0, justStarted: false,
    lastSoundAt: 0, lastWelcomeAt: 0, soundsInWindow: 0,
    windowStartAt: 0, random: 0.99,
}, over);

console.log('=== 可爱动静判据 ===\n');

// 1) 她在说话 → 绝对安静（可爱不能盖住她）
let d = decideCuteSound(T({ speaking: true, idleMs: 9e5 }), {});
ck('她在说话 → 不出声', d.play === false, JSON.stringify(d));

d = decideCuteSound(T({ idleMs: 9e5 }), { enabled: false });
ck('enabled=false → 不出声', d.play === false, JSON.stringify(d));

d = decideCuteSound(T({ justStarted: true }), {});
ck('启动 → chirp', d.play === true && d.sound === 'chirp', JSON.stringify(d));

d = decideCuteSound(T({ justStarted: true, lastSoundAt: NOW - 5000 }), {});
ck('启动音 5s 内重试 → 冷却', d.play === false, JSON.stringify(d));
d = decideCuteSound(T({ justStarted: true, lastSoundAt: NOW - 60000 }), {});
ck('启动音 60s 后 → 可再响', d.play === true && d.sound === 'chirp', JSON.stringify(d));

d = decideCuteSound(T({ idleMs: 11 * 60000 }), {});
ck('静默11分钟 → welcome', d.play === true && d.sound === 'welcome', JSON.stringify(d));

// 6) welcome 自己的冷却（2 分钟）——不能被 45s 普通冷却逻辑误伤
d = decideCuteSound(T({ idleMs: 11 * 60000, lastWelcomeAt: NOW - 60000 }), {});
ck('welcome 1分钟内重来 → 不响', d.play === false, JSON.stringify(d));
d = decideCuteSound(T({ idleMs: 11 * 60000, lastWelcomeAt: NOW - 130000 }), {});
ck('welcome 2分10秒后 → 再响', d.play === true && d.sound === 'welcome', JSON.stringify(d));

d = decideCuteSound(T({ idleMs: 6 * 60000 }), {});
ck('空闲6分钟 → hum/yawn', d.play === true && ['hum', 'yawn'].includes(d.sound), JSON.stringify(d));

d = decideCuteSound(T({ lastSoundAt: NOW - 20000 }), {});
ck('20s 前出过声 → 冷却', d.play === false, JSON.stringify(d));

// 9) 10 分钟窗口次数上限
d = decideCuteSound(T({ soundsInWindow: 6, lastSoundAt: NOW - 60000 }), {});
ck('窗口内已 6 次 → 不出声', d.play === false, JSON.stringify(d));

d = decideCuteSound(T({ soundsInWindow: 6, windowStartAt: NOW - 700000, lastSoundAt: NOW - 60000 }), {});
ck('窗口过期 → 计数重置（随机不中时也不该因次数被拦）', d.play === false && d.why !== '10分钟次数用尽', JSON.stringify(d));

d = decideCuteSound(T({ random: 0.03 }), {});
ck('random=0.03 → 随机出声', d.play === true, JSON.stringify(d));
d = decideCuteSound(T({ random: 0.5 }), {});
ck('random=0.5 → 不响', d.play === false, JSON.stringify(d));

ck('DEFAULTS.volume 很小（不吵）', DEFAULTS.volume <= 0.2, DEFAULTS.volume);
ck('DEFAULTS.cooldown_s = 45', DEFAULTS.cooldown_s === 45);
ck('DEFAULTS.random_chance 很小', DEFAULTS.random_chance <= 0.1);

let soundsOk = true;
for (const name of ['welcome', 'chirp', 'hum', 'yawn', 'giggle', 'curious']) {
    const notes = SOUNDS[name];
    if (!Array.isArray(notes) || !notes.length) { soundsOk = false; break; }
    for (const n of notes) {
        if (!(n.f >= 200 && n.f <= 4000)) { soundsOk = false; break; }
        if (!(n.d >= 40 && n.d <= 600)) { soundsOk = false; break; }
    }
}
ck('音效定义健全（频率/时长在合理区间）', soundsOk);

const a = decideCuteSound(T({ random: 0.03 }), {});
const b = decideCuteSound(T({ random: 0.03 }), {});
ck('确定性（同输入同输出）', JSON.stringify(a) === JSON.stringify(b));

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
