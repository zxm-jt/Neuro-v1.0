'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');

const map = require(path.join(ROOT, 'js', 'expression-map.js'));
const C = require(path.join(ROOT, 'js', 'emotion-classifier.js'));
const K = require(path.join(ROOT, 'js', 'emotion-keys.js'));

let pass = 0, fail = 0;
const ck = (name, ok, detail) => {
    if (ok) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? ' → ' + detail : ''}`); }
};

const NEW_KEYS = [
    'sleepy', 'dizzy', 'mischievous', 'proud', 'relieved', 'touched',
    'scheming', 'trembling', 'facepalm', 'sparkle', 'content_squint', 'guilty',
];

const RANGE = {
    ParamCheek: [0, 5.37], ParamEyeLOpen: [0, 7.07], ParamEyeROpen: [0, 7.07],
    ParamEyeLSmile: [0, 4.40], ParamEyeRSmile: [0, 4.40],
    ParamEyeBallX: [-1, 1], ParamEyeBallY: [-1, 1],
    ParamBrowLY: [-1, 4.67], ParamBrowRY: [-1, 4.67],
    ParamBrowLAngle: [-1, 8.57], ParamBrowRAngle: [-1, 8.57],
    ParamBrowLForm: [-1, 8.57], ParamBrowRForm: [-1, 8.57],
    ParamMouthForm: [-2, 6.63],
    ParamAngleY: [-30, 30], ParamAngleZ: [-30, 30],
    ParamShoulder: [-1, 5.37], ParamBodyAngleX: [-10, 10],
};
const MOTIONS = ['Idle', 'TapBody', 'Cheer', 'Think', 'Gentle', 'Sad', 'Angry'];
const inRange = (flat) => Object.keys(flat).every((id) => {
    const r = RANGE[id];
    return !!r && flat[id] >= r[0] && flat[id] <= r[1];
});

console.log('\n=== 表情丰富度专项校验 ===\n');

console.log('[A] 新表情键进入目录');
for (const k of NEW_KEYS) {
    ck(`${k} 在 EXPRESSION_KEYS 里`, map.EXPRESSION_KEYS.includes(k));
    ck(`${k} 有定义`, !!map.getExpression(k));
}
ck('目录总数达到 40（28 + 12）', map.EXPRESSION_KEYS.length === 40, map.EXPRESSION_KEYS.length);

console.log('\n[B] 新表情参数合法且在模型量程内');
for (const k of NEW_KEYS) {
    const e = map.getExpression(k);
    ck(`${k}: face/use/motion/hold 齐全`, !!(e.face && e.use && e.motion && e.hold));
    ck(`${k}: motion "${e.motion}" 是模型真实动作组`, MOTIONS.includes(e.motion), e.motion);
    ck(`${k}: hold > 0`, e.hold > 0, e.hold);
    const flat = map.flattenParams(e);
    ck(`${k}: 至少写了 4 个参数（不是空脸）`, Object.keys(flat).length >= 4, Object.keys(flat).length);
    ck(`${k}: 所有参数在量程内`, inRange(flat), JSON.stringify(flat));
    // 字段本身也必须被 PARAM_IDS 认识（防止写错字段名静默失效）
    const unknown = Object.keys(e.params).filter((f) => !map.PARAM_IDS[f]);
    ck(`${k}: 无未知字段`, unknown.length === 0, unknown.join(','));
}

console.log('\n[C] 表情之间有区分度（参数组合不完全相同）');
const flatOf = (k) => JSON.stringify(Object.keys(map.flattenParams(map.getExpression(k)))
    .sort().map((id) => [id, map.flattenParams(map.getExpression(k))[id]]));
for (let i = 0; i < NEW_KEYS.length; i++) {
    for (let j = i + 1; j < NEW_KEYS.length; j++) {
        ck(`${NEW_KEYS[i]} ≠ ${NEW_KEYS[j]}`, flatOf(NEW_KEYS[i]) !== flatOf(NEW_KEYS[j]));
    }
}
const OLD_KEYS = map.EXPRESSION_KEYS.filter((k) => !NEW_KEYS.includes(k));
for (const k of NEW_KEYS) {
    ck(`${k}: 不与任何旧表情完全相同`,
        OLD_KEYS.every((o) => flatOf(k) !== flatOf(o)));
}

console.log('\n[D] blendExpressions 合法、可叠加、不污染入参');
const base = map.flattenParams(map.getExpression('happy'));
const baseCopy = JSON.stringify(base);
const blink = map.blendExpressions('happy', ['blink'], 1);
ck('blink 把 happy 的睁眼压到 0（闭眼笑）', blink.ParamEyeLOpen === 0, blink.ParamEyeLOpen);
ck('blink 输出全在量程内', inRange(blink));
ck('blend 不修改入参', JSON.stringify(base) === baseCopy);

const bright = map.blendExpressions('surprised', ['bright_pupil'], 0.5);
ck('bright_pupil 让瞳孔上移', bright.ParamEyeBallY > 0, bright.ParamEyeBallY);
ck('bright_pupil 输出全在量程内', inRange(bright));

const b1 = map.blendExpressions('happy', ['blush_deep'], 0.5);
const b2 = map.blendExpressions(b1, ['brow_raise'], 0.5);
ck('可叠加：二次 blend 合法', inRange(b2));
ck('可叠加：二次 blend 确实改变了脸', JSON.stringify(b1) !== JSON.stringify(b2));
ck('叠加后腮红仍在量程内', b2.ParamCheek <= RANGE.ParamCheek[1], b2.ParamCheek);

const cross = map.blendExpressions('happy', ['surprised'], 0.3);
ck('跨表情混合：睁眼介于两者之间',
    cross.ParamEyeLOpen > base.ParamEyeLOpen
    && cross.ParamEyeLOpen < map.flattenParams(map.getExpression('surprised')).ParamEyeLOpen,
    cross.ParamEyeLOpen);
ck('跨表情混合输出合法', inRange(cross));
ck('无 modifier 时原样返回',
    JSON.stringify(map.blendExpressions('happy', null, 0.5)) === baseCopy);
ck('微表情键齐全', Object.keys(map.MICRO_EXPRESSIONS).length >= 8);
ck('情境→微表情映射可用', !!map.microForSignal('praised'));

console.log('\n[E] 情境 signal + 注入 rng 能覆盖新表情');
const PLAIN = '嗯，好吧。';
for (const sig of Object.keys(C.SIGNAL_POOLS)) {
    const pool = C.SIGNAL_POOLS[sig];
    const hit = new Set();
    for (let i = 0; i < pool.length; i++) {
        const rng = () => (i + 0.1) / pool.length;
        const r = C.classify(PLAIN, { signal: sig, rng });
        hit.add(r.key);
        ck(`signal=${sig} idx=${i} → ${pool[i]}`, r.key === pool[i], r.key);
    }
    ck(`signal=${sig} 覆盖池内全部 ${pool.length} 张脸`, hit.size === pool.length, [...hit].join(','));
}
ck('情境别名生效（just_praised ≈ praised）',
    C.pick(PLAIN, { signal: 'just_praised', rng: () => 0.01 })
    === C.pick(PLAIN, { signal: 'praised', rng: () => 0.01 }));
const strong = C.classify('I am so happy!', { signal: 'corrected', rng: () => 0.01 });
ck('词典强命中不被情境覆盖',
    strong.strong === true && !C.SIGNAL_POOLS.corrected.includes(strong.key), strong.key);
ck('不传 signal 时行为不变（仍落在 SOFT_POOL/neutral）',
    C.SOFT_POOL.includes(C.pick(PLAIN, { rng: () => 0.99 }))
    || C.pick(PLAIN, { rng: () => 0.99 }) === 'neutral');
ck('词典能直接命中 sleepy', C.pick('我好困啊', { rng: () => 0.99 }) === 'sleepy');
ck('词典能直接命中 facepalm', C.pick('扶额，我服了', { rng: () => 0.99 }) === 'facepalm');

console.log('\n[F] 别名映射不丢新键');
for (const k of NEW_KEYS) {
    ck(`${k} 归一化后仍是 ${k}`, K.normalizeEmotionKey(k) === k, K.normalizeEmotionKey(k));
}
const ALIAS_CASES = [
    ['drowsy', 'sleepy'], ['vertigo', 'dizzy'], ['impish', 'mischievous'],
    ['proud', 'proud'], ['phew', 'relieved'], ['touched', 'touched'],
    ['scheming', 'scheming'], ['trembling', 'trembling'], ['facepalm', 'facepalm'],
    ['sparkle', 'sparkle'], ['contented', 'content_squint'], ['guilty', 'guilty'],
    ['头晕', 'dizzy'], ['骄傲', 'proud'], ['感动', 'touched'], ['心虚', 'guilty'],
];
for (const [inp, want] of ALIAS_CASES) {
    ck(`"${inp}" → ${want}`, K.normalizeEmotionKey(inp) === want, K.normalizeEmotionKey(inp));
}

console.log('\n[G] 微表情已接入 model-interaction（不新起帧循环）');
const _listeners = {};
global.window = {
    innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1,
    addEventListener(ev, cb) { (_listeners[ev] = _listeners[ev] || []).push(cb); },
    removeEventListener() { },
};
global.document = { addEventListener() { }, removeEventListener() { }, body: { style: {} } };
const { ModelInteractionController } = require(path.join(ROOT, 'js', 'model-interaction.js'));

const params = {};
const fake = {
    on() { return this; }, off() { return this; },
    internalModel: {
        coreModel: { setParameterValueById(id, v) { params[id] = v; } },
        on() { }, motion() { return true; },
        motionManager: { definitions: { Idle: [1], Cheer: [1], Think: [1], Gentle: [1], Sad: [1], Angry: [1] }, startMotion() { return true; } },
    },
    motion() { return true; },
};
const ctrl = new ModelInteractionController();
ctrl.model = fake;
ctrl.app = { renderer: { width: 1920, height: 1080 } };
ctrl.init(fake, ctrl.app);

ctrl.applyEmotion('happy', { modifiers: ['blink'], modifierWeight: 1 });
ck('applyEmotion 带 modifier 时：睁眼被压到 0', params.ParamEyeLOpen === 0, params.ParamEyeLOpen);
ck('applyEmotion 带 modifier 时：其它参数保留', params.ParamMouthForm === 2, params.ParamMouthForm);
ctrl.setExpressionModifiers(null);
ctrl.applyEmotion('happy');
ck('清除 modifier 后恢复基础表情', params.ParamEyeLOpen === 1.2, params.ParamEyeLOpen);
ck('平滑过渡默认关闭（零配置不改旧行为）', !ctrl._exprSmoothMs, ctrl._exprSmoothMs);

console.log('\n[H] 跨文件同步：MOTION_BIAS 与后端白名单/别名');
const fs = require('fs');
const MP = require(path.join(ROOT, 'js', 'motion-policy.js'));
for (const k of NEW_KEYS) {
    const b = MP.MOTION_BIAS[k];
    ck(`${k}: MOTION_BIAS 存在且在 (0,1]`, typeof b === 'number' && b > 0 && b <= 1, b);
}
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'backend', 'agent_bridge.py'), 'utf8');
const validStart = bridgeSrc.indexOf('_VALID_EMO = {');
const validBlock = bridgeSrc.slice(validStart, bridgeSrc.indexOf('_EMO_RULES = [', validStart));
for (const k of NEW_KEYS) {
    ck(`${k}: 后端 _VALID_EMO 已收录`, new RegExp('"' + k + '"').test(validBlock));
}
const aliasStart = bridgeSrc.indexOf('_EMO_ALIAS = {');
const aliasBlock = bridgeSrc.slice(aliasStart, bridgeSrc.indexOf('\n}', aliasStart));
for (const [k, want] of [['mischievous', 'mischievous'], ['proud', 'proud'],
                         ['impish', 'mischievous']]) {
    ck(`后端别名 "${k}" → ${want}（不再折进 playful/smug）`,
        new RegExp('"' + k + '"\\s*:\\s*"' + want + '"').test(aliasBlock));
}

console.log(`\n结果：${pass} PASS / ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
