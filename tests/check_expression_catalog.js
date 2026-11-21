'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const map = require(path.join(ROOT, 'js', 'expression-map.js'));
const keys = require(path.join(ROOT, 'js', 'emotion-keys.js'));

let pass = 0, fail = 0;
const ck = (name, ok, detail) => {
    if (ok) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? ' → ' + detail : ''}`); }
};

const modelDir = path.join(ROOT, '2D');
const modelFile = fs.readdirSync(modelDir).find(f => f.endsWith('.model3.json') && !f.includes('-2024') && !f.includes('-2025'));
const model3 = JSON.parse(fs.readFileSync(path.join(modelDir, modelFile), 'utf8'));
const motionGroups = Object.keys(model3.FileReferences.Motions || {});
const cdiFile = (model3.FileReferences.DisplayInfo || 'Hiyori.cdi3.json');
const cdi = JSON.parse(fs.readFileSync(path.join(modelDir, cdiFile), 'utf8'));
const modelParams = new Set((cdi.Parameters || []).map(p => p.Id));

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

console.log(`\n=== 表情目录校验（模型：${modelFile}）===\n`);

console.log('[A] 目录完整性');
for (const key of map.EXPRESSION_KEYS) {
    const e = map.EXPRESSIONS[key];
    ck(`${key}: 有 face/use/motion/hold`,
        !!(e.face && e.use && e.motion && e.hold),
        JSON.stringify({ face: e.face, use: e.use, motion: e.motion, hold: e.hold }));
}

console.log('\n[B] 动作组必须在 model3.json 里真实存在');
for (const key of map.EXPRESSION_KEYS) {
    const g = map.EXPRESSIONS[key].motion;
    ck(`${key} → 动作组 "${g}" 存在`, motionGroups.includes(g), motionGroups.join(','));
}

// C) 参数 id 真实存在
console.log('\n[C] 参数 id 必须在模型参数表里真实存在');
for (const key of map.EXPRESSION_KEYS) {
    const flat = map.flattenParams(map.EXPRESSIONS[key]);
    for (const id of Object.keys(flat)) {
        ck(`${key}: ${id} 存在`, modelParams.has(id), `模型参数表里没有 ${id}`);
    }
}

console.log('\n[D] 前后端规范键一致');
const PY = 'C:/Users/<YOUR_USER>/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
let pyOut = null;
try {
    const code = [
        'import sys, json',
        `sys.path.insert(0, r"${path.join(ROOT, 'backend').replace(/\\/g, '\\\\')}")`,
        'import agent_bridge as ab',
        'print(json.dumps({"valid": sorted(ab._VALID_EMO), "alias": ab._EMO_ALIAS}, ensure_ascii=False))',
    ].join('\n');
    pyOut = JSON.parse(execFileSync(PY, ['-c', code], { encoding: 'utf8', cwd: path.join(ROOT, 'backend') }).trim());
} catch (e) {
    console.log('  SKIP  后端 Python 不可用：' + (e.message || e));
}
if (pyOut) {
    const pyValid = new Set(pyOut.valid);
    const jsValid = new Set(map.EXPRESSION_KEYS);
    const missingInPy = [...jsValid].filter(k => !pyValid.has(k));
    const missingInJs = [...pyValid].filter(k => !jsValid.has(k));
    ck('后端能发的每个键，前端都有对应表情', missingInPy.length === 0, missingInPy.join(','));
    ck('前端有的每个表情，后端都认（否则她发不出来）', missingInJs.length === 0, missingInJs.join(','));
    const aliasSrc = fs.readFileSync(path.join(ROOT, 'backend', 'agent_bridge.py'), 'utf8');
    const aliasBlock = aliasSrc.slice(aliasSrc.indexOf('_EMO_ALIAS = {'), aliasSrc.indexOf('_EMO_SUFFIXES'));
    const aliasNoComment = aliasBlock.split('\n')
        .map(line => line.replace(/#.*$/, '')).join('\n');
    const seen = new Set(), dup = [];
    for (const m of aliasNoComment.matchAll(/"([^"]+)"\s*:\s*"[^"]+"/g)) {
        if (seen.has(m[1])) dup.push(m[1]); else seen.add(m[1]);
    }
    ck('后端别名表无重复键', dup.length === 0, dup.join(','));
}

console.log('\n[E] 新表情不被别名/前缀规则折走');
const MUST_STAY = ['blush', 'look_down', 'starry_eyes', 'gentle_smile', 'thoughtful', 'curious', 'concerned'];
for (const k of MUST_STAY) {
    ck(`${k} → 仍是 ${k}`, keys.normalizeEmotionKey(k) === k, keys.normalizeEmotionKey(k));
}
const VARIANTS = [
    ['blushing', 'blush'], ['flushed', 'blush'], ['rosy', 'blush'],
    ['look down', 'look_down'], ['downcast', 'look_down'],
    ['starry', 'starry_eyes'], ['sparkling', 'starry_eyes'],
    ['gentle', 'gentle_smile'], ['soft smile', 'gentle_smile'],
    ['reflective', 'thoughtful'], ['philosophical', 'thoughtful'],
    ['intrigued', 'curious'], ['wondering', 'curious'],
    ['caring', 'concerned'], ['empathetic', 'concerned'],
    ['脸红', 'blush'], ['星星眼', 'starry_eyes'], ['好奇', 'curious'], ['担忧', 'concerned'],
];
for (const [inp, want] of VARIANTS) {
    ck(`"${inp}" → ${want}`, keys.normalizeEmotionKey(inp) === want, keys.normalizeEmotionKey(inp));
}

// F) 参数值不越界
console.log('\n[F] 参数值不超模型量程');
for (const key of map.EXPRESSION_KEYS) {
    const flat = map.flattenParams(map.EXPRESSIONS[key]);
    for (const id of Object.keys(flat)) {
        const r = RANGE[id];
        if (!r) continue;
        const v = flat[id];
        ck(`${key}: ${id}=${v} 在 [${r[0]}, ${r[1]}] 内`, v >= r[0] && v <= r[1]);
    }
}

// G) neutral 必须是"什么都不写"（回到默认状态）
console.log('\n[G] neutral = 回到默认状态');
ck('neutral 不写任何参数', Object.keys(map.flattenParams(map.getExpression('neutral'))).length === 0);
ck('neutral 有动作组（不做到完全不动）', !!map.getExpression('neutral').motion);

console.log(`\n结果：${pass} PASS / ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
