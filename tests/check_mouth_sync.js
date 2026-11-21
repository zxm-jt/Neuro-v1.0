const path = require('path');
const { ModelInteractionController } = require(path.join(__dirname, '..', 'js', 'model-interaction.js'));

let pass = 0, fail = 0;
function ck(name, cond, extra) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

function makeFakeModel() {
    const params = {};
    const model = {
        internalModel: {
            coreModel: {
                setParameterValueById(id, v) { params[id] = v; },
            },
            update(dt, now) {
                params['ParamMouthOpenY'] = 0.05;
                params['ParamBrowLY'] = -0.1;
            },
        },
    };
    return { model, params };
}

(async () => {
    {
        const mc = new ModelInteractionController();
        const { model, params } = makeFakeModel();
        mc.model = model;
        mc.setMouthOpenY(0.8);
        model.internalModel.update(16, 16);
        ck('事故复现：无 hook 时口型被 motion 曲线覆盖',
            params['ParamMouthOpenY'] === 0.05, params['ParamMouthOpenY']);
    }

    {
        const mc = new ModelInteractionController();
        const { model, params } = makeFakeModel();
        mc.model = model;
        mc._installLiveParamHook();
        mc.setMouthOpenY(0.8);
        model.internalModel.update(16, 16);
        ck('修复：hook 在曲线之后写入，口型生效',
            params['ParamMouthOpenY'] === 0.8, params['ParamMouthOpenY']);

        mc.setMouthOpenY(0.3);
        model.internalModel.update(16, 16);
        ck('口型随音频值逐帧变化',
            params['ParamMouthOpenY'] === 0.3, params['ParamMouthOpenY']);

        // 只写嘴型，不碰 motion 的其他参数
        ck('不碰 motion 的其他参数（眉毛还是 motion 的值）',
            params['ParamBrowLY'] === -0.1, params['ParamBrowLY']);
    }

    {
        const mc = new ModelInteractionController();
        const { model, params } = makeFakeModel();
        mc.model = model;
        mc._installLiveParamHook();

        const realNow = performance.now.bind(performance);
        let fakeNow = 1000;
        performance.now = () => fakeNow;
        try {
            mc.setMouthOpenY(0.9);
            fakeNow = 1300;
            model.internalModel.update(16, 16);
            ck('新鲜期内口型生效', params['ParamMouthOpenY'] === 0.9, params['ParamMouthOpenY']);

            fakeNow = 1600;
            model.internalModel.update(16, 16);
            ck('过期后把嘴还给 motion 曲线',
                params['ParamMouthOpenY'] === 0.05, params['ParamMouthOpenY']);

            fakeNow = 1700;
            mc.setMouthOpenY(0.5);
            model.internalModel.update(16, 16);
            ck('续喂值后重新生效', params['ParamMouthOpenY'] === 0.5, params['ParamMouthOpenY']);
        } finally {
            performance.now = realNow;
        }
    }

    {
        const mc = new ModelInteractionController();
        const { model } = makeFakeModel();
        mc.model = model;
        mc._installLiveParamHook();
        mc.setMouthOpenY(2.5);
        ck('超上限钳到 1.0', mc._mouthValue === 1.0, mc._mouthValue);
        mc.setMouthOpenY(-1);
        ck('负值钳到 0', mc._mouthValue === 0, mc._mouthValue);
        mc.setMouthOpenY(NaN);
        ck('NaN 当 0', mc._mouthValue === 0, mc._mouthValue);
        mc.setMouthOpenY(undefined);
        ck('undefined 当 0', mc._mouthValue === 0, mc._mouthValue);
    }

    {
        const mc = new ModelInteractionController();
        const { model } = makeFakeModel();
        mc.model = model;
        mc._installLiveParamHook();
        const first = model.internalModel.update;
        mc._installLiveParamHook();
        ck('重复安装被防住（不叠层）', model.internalModel.update === first);
    }

    {
        const mc = new ModelInteractionController();
        let err = null;
        try {
            mc.setMouthOpenY(0.5);
            mc._installLiveParamHook();
            mc._applyLiveParams();
        } catch (e) { err = e; }
        ck('无模型时不抛异常', err === null, err && err.message);
    }

    console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
    process.exit(fail > 0 ? 1 : 0);
})();
