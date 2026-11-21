const path = require('path');
const { ModelInteractionController } = require(path.join(__dirname, '..', 'js', 'model-interaction.js'));

let pass = 0, fail = 0;
function ck(name, cond, extra) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

// 假模型：严格复刻 cubism4.es.js 的 update() 顺序
function makeFakeModel(opts = {}) {
    const motionMouth = opts.motionMouth;
    const params = {};
    const baked = {};
    const handlers = {};

    const coreModel = {
        setParameterValueById(id, v) { params[id] = v; },
        getParameterValueById(id) { return params[id]; },
    };

    const internalModel = {
        coreModel,
        on(ev, cb) { (handlers[ev] = handlers[ev] || []).push(cb); },
        emit(ev) { (handlers[ev] || []).forEach(f => f()); },
        update(dt, now) {
            if (motionMouth !== undefined) {
                coreModel.setParameterValueById('ParamMouthOpenY', motionMouth);
            }
            coreModel.setParameterValueById('ParamBrowLY', -0.1);
            // ② afterMotionUpdate（表情参数 + 口型在这里写）
            this.emit('afterMotionUpdate');
            const saved = Object.assign({}, params);
            Object.assign(baked, params);
            for (const k of Object.keys(params)) delete params[k];
            Object.assign(params, saved);
        },
    };

    return { model: { internalModel }, params, baked, handlers };
}

function setup(opts) {
    const mc = new ModelInteractionController();
    const f = makeFakeModel(opts);
    mc.model = f.model;
    mc._installLiveParamHook();
    mc._installExpressionHook();
    return { mc, f };
}

console.log('[1] 待机 Idle（motion 不动画口型）');
{
    const { mc, f } = setup({});
    mc.setMouthOpenY(0.8);
    f.model.internalModel.update(16, 16);
    ck('口型生效（画出去的值 = 0.8）', f.baked['ParamMouthOpenY'] === 0.8,
        f.baked['ParamMouthOpenY']);
    ck('眉毛仍归 motion 管', f.baked['ParamBrowLY'] === -0.1, f.baked['ParamBrowLY']);
}

console.log('\n[2] 情绪动作播放中（motion 动画口型，曲线值 0.05）—— 本 bug 的核心场景');
{
    const { mc, f } = setup({ motionMouth: 0.05 });
    mc.setMouthOpenY(0.8);
    f.model.internalModel.update(16, 16);
    ck('口型仍然生效（画出去的值 = 0.8，不被 motion 盖成 0.05）',
        f.baked['ParamMouthOpenY'] === 0.8, f.baked['ParamMouthOpenY']);
    ck('修复前会是 0.05（motion 曲线赢）—— 现在不是',
        f.baked['ParamMouthOpenY'] !== 0.05, f.baked['ParamMouthOpenY']);
}

console.log('\n[3] 连续多帧、值变化（口型要真的在动）');
{
    const { mc, f } = setup({ motionMouth: 0.05 });
    const seen = [];
    for (const v of [0.9, 0.4, 0.7, 0.2]) {
        mc.setMouthOpenY(v);
        f.model.internalModel.update(16, 16);
        seen.push(f.baked['ParamMouthOpenY']);
    }
    ck('每帧画出去的口型都跟着音频值变',
        JSON.stringify(seen) === JSON.stringify([0.9, 0.4, 0.7, 0.2]),
        JSON.stringify(seen));
}

console.log('\n[4] 表情参数与口型同时生效（互不打架）');
{
    const { mc, f } = setup({ motionMouth: 0.05 });
    mc._exprParams = { ParamCheek: 4.2, ParamMouthForm: 0.6 };
    mc.setMouthOpenY(0.75);
    f.model.internalModel.update(16, 16);
    ck('表情参数生效（脸颊红）', f.baked['ParamCheek'] === 4.2, f.baked['ParamCheek']);
    ck('表情的嘴型（ParamMouthForm）生效', f.baked['ParamMouthForm'] === 0.6,
        f.baked['ParamMouthForm']);
    ck('口型同时生效（三者共存）', f.baked['ParamMouthOpenY'] === 0.75,
        f.baked['ParamMouthOpenY']);
}

console.log('\n[5] 不说话时把嘴还给 motion（新鲜期过后不抢）');
{
    const { mc, f } = setup({ motionMouth: 0.05 });
    mc.setMouthOpenY(0.8);
    f.model.internalModel.update(16, 16);
    ck('新鲜期内口型生效', f.baked['ParamMouthOpenY'] === 0.8, f.baked['ParamMouthOpenY']);
    const realNow = performance.now.bind(performance);
    mc._now = () => realNow() + 5000;
    f.model.internalModel.update(32, 32);
    ck('过期后嘴还给 motion 曲线', f.baked['ParamMouthOpenY'] === 0.05,
        f.baked['ParamMouthOpenY']);
}

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
