'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');

const _winListeners = {};
global.window = {
    innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1,
    addEventListener(ev, cb) { (_winListeners[ev] = _winListeners[ev] || []).push(cb); },
    removeEventListener() { },
};
global.document = { addEventListener() { }, removeEventListener() { }, body: { style: {} } };

const { ModelInteractionController } = require(path.join(ROOT, 'js', 'model-interaction.js'));
const { EXPRESSIONS, EXPRESSION_KEYS, flattenParams } = require(path.join(ROOT, 'js', 'expression-map.js'));

let pass = 0, fail = 0;
const ck = (name, ok, detail) => {
    if (ok) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? ' → ' + detail : ''}`); }
};

function makeFakeModel() {
    const params = {};              // 参数 id → 当前值
    const writes = [];
    const listeners = {};
    const model = {
        params, writes,
        on() { return this; },
        off() { return this; },
        internalModel: {
            coreModel: {
                setParameterValueById(id, v) {
                    params[id] = v;
                    writes.push({ id, v });
                },
            },
            on(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); },
            emit(ev) { (listeners[ev] || []).forEach(cb => cb()); },
            motionManager: {
                definitions: {
                    Idle: [{ File: 'x' }], Cheer: [{ File: 'x' }],
                    Think: [{ File: 'x' }], Gentle: [{ File: 'x' }],
                    Sad: [{ File: 'x' }], Angry: [{ File: 'x' }],
                },
                startMotion() { return true; },
            },
            motion(group, index, priority) { return true; },
        },
    };
    return model;
}

console.log('\n=== 表情链路验证 ===\n');

console.log('[1] 表情目录 → 参数写入');
const fake = makeFakeModel();
const ctrl = new ModelInteractionController();
ctrl.model = fake;
ctrl.app = { renderer: { width: 1920, height: 1080 } };
ctrl.init(fake, ctrl.app);

// applyEmotion 之后，参数必须真的写进核心模型
fake.writes.length = 0;
ctrl.applyEmotion('blush');
const blushWrites = fake.writes.slice();
const cheek = blushWrites.find(w => w.id === 'ParamCheek');
ck('blush 写入了 ParamCheek', !!cheek, JSON.stringify(blushWrites));
ck('blush 的脸颊红度 > 3（模型量程 0~5.37，明显可见）', cheek && cheek.v > 3, cheek && cheek.v);

// 每个表情都要能写出一组参数
for (const key of EXPRESSION_KEYS) {
    fake.writes.length = 0;
    ctrl.applyEmotion(key);
    const ids = new Set(fake.writes.map(w => w.id));
    const flat = flattenParams(EXPRESSIONS[key]);
    const expect = Object.keys(flat);
    const okAll = expect.every(id => ids.has(id));
    ck(`${key}: 目录里的参数全部写入（${expect.length} 个）`, okAll,
        expect.filter(id => !ids.has(id)).join(','));
}

console.log('\n[2] 关键回归：表情参数不能被 motion 曲线覆盖');
// 模拟一帧：motion 先把参数写成它自己的值（覆盖），然后 afterMotionUpdate 触发
fake.writes.length = 0;
ctrl.applyEmotion('starry_eyes');
const starry = flattenParams(EXPRESSIONS.starry_eyes);

// —— 模拟 motion 覆盖：把参数全改成 motion 自己的值
for (const id of Object.keys(starry)) {
    fake.internalModel.coreModel.setParameterValueById(id, -999);
}
ck('模拟 motion 覆盖后参数确实被盖掉了', fake.params.ParamCheek === -999, fake.params.ParamCheek);

fake.internalModel.emit('afterMotionUpdate');
const survived = Object.keys(starry).every(id => fake.params[id] === starry[id]);
ck('afterMotionUpdate 之后表情参数全部存活', survived,
    Object.keys(starry).filter(id => fake.params[id] !== starry[id]).join(','));

console.log('\n[3] 表情切换时，上一个表情的参数必须被清掉');
fake.writes.length = 0;
ctrl.applyEmotion('blush');
ck('blush 写入了 ParamCheek', fake.params.ParamCheek > 0, fake.params.ParamCheek);
ctrl.applyEmotion('thoughtful');             // 换成若有所思（目录里没有脸颊参数）
ck('换表情后 ParamCheek 被清零', fake.params.ParamCheek === 0, fake.params.ParamCheek);
ck('新表情自己的参数写进去了', fake.params.ParamBrowLForm > 0, fake.params.ParamBrowLForm);

console.log('\n[4] neutral = 回到默认状态（不写任何参数，不抹平 motion 动画）');
ctrl.applyEmotion('blush');
const beforeNeutral = fake.params.ParamCheek;
const blushIds = new Set(Object.keys(flattenParams(EXPRESSIONS.blush)));
// 只看【切到 neutral 这一次】写了哪些参数
fake.writes.length = 0;
ctrl.applyEmotion('neutral');
const neutralWrites = fake.writes.slice();
ck('neutral 清掉了上一个表情残留（ParamCheek=0）', fake.params.ParamCheek === 0, fake.params.ParamCheek);
ck('neutral 之前确实有残留（说明上一条不是假阳性）', beforeNeutral > 0, beforeNeutral);
// neutral 只允许清"上一个表情写过的"那些参数 —— 不能去动别的参数
const touched = new Set(neutralWrites.map(w => w.id));
const touchedOutside = [...touched].filter(id => !blushIds.has(id));
ck('neutral 只清自己写过的参数，不越界', touchedOutside.length === 0, touchedOutside.join(','));
ck('neutral 的写入全部是"清零"而不是"设置新值"',
    neutralWrites.every(w => w.v === 0), JSON.stringify(neutralWrites.slice(0, 3)));

console.log('\n[5] 表情回落：到时自动回中性');
fake.writes.length = 0;
ctrl.applyEmotion('curious');
ck('curious 已应用', ctrl.emotion === 'curious', ctrl.emotion);
ctrl._scheduleExpressionHold('curious');
ck('回落定时器已挂上', !!ctrl._exprHoldTimer);

console.log(`\n结果：${pass} PASS / ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
