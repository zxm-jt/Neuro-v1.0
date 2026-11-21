'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const map = require(path.join(ROOT, 'js', 'expression-map.js'));
const keys = require(path.join(ROOT, 'js', 'emotion-keys.js'));

const L = [];
L.push('# 表情触发词总表');
L.push('');
L.push('> 本文件由 `node tools/gen_expression_doc.js` 从 `js/expression-map.js`（表情目录）自动生成，**不要手改**。');
L.push('> 改表情请改目录，然后重新生成。');
L.push('');
L.push('## 一、标签 = 控制指令，不是台词');
L.push('');
L.push('方括号标签只驱动 Live2D 的脸和身体：');
L.push('- **不会被念出来**（TTS 文本在 `js/tts-processor.js` 的 `stripEmotionTags()` 里被剥掉）');
L.push('- **不会出现在字幕里**（字幕与 TTS 同源，用的是剥完标签的正文）');
L.push('- 情绪本身通过 SSE 的独立事件 `{"type":"emotion"}` 下发，与正文分开');
L.push('');
L.push('## 二、表情目录（' + map.EXPRESSION_KEYS.length + ' 个）');
L.push('');
L.push('| 标签 | 预期表情 | 典型用法 | 动作组 | 保持(ms) |');
L.push('|---|---|---|---|---|');
for (const key of map.EXPRESSION_KEYS) {
    const e = map.EXPRESSIONS[key];
    L.push(`| \`[${key}]\` | ${e.face} | ${e.use} | ${e.motion} | ${e.hold} |`);
}
L.push('');
L.push('## 三、各表情用了哪些模型参数');
L.push('');
L.push('模型没有表情文件(Expressions)，全部靠写参数画出来。参数含义：');
L.push('');
L.push('| 字段 | 模型参数 | 含义 |');
L.push('|---|---|---|');
const DESC = {
    bL: ['ParamBrowLY / ParamBrowRY', '眉毛高低（正=上抬）'],
    bA: ['ParamBrowLAngle / ParamBrowRAngle', '眉毛角度（正=内端下压/严肃，负=柔和）'],
    bF: ['ParamBrowLForm / ParamBrowRForm', '眉形（负=尖锐/皱，正=平缓）'],
    eye: ['ParamEyeLSmile / ParamEyeRSmile', '笑眼'],
    eOpen: ['ParamEyeLOpen / ParamEyeROpen', '睁眼程度（0=闭眼）'],
    ballX: ['ParamEyeBallX', '视线左右'],
    ballY: ['ParamEyeBallY', '视线上下（EYE_BALL_Y_DOWN 负=向下）'],
    mouth: ['ParamMouthForm', '嘴型（正=上翘微笑，负=下撇）'],
    cheek: ['ParamCheek', '脸红'],
    angleY: ['ParamAngleY', '头俯仰（正=抬头）'],
    angleZ: ['ParamAngleZ', '头歪斜'],
    shoulder: ['ParamShoulder', '耸肩'],
    bodyX: ['ParamBodyAngleX', '身体转'],
};
for (const f of Object.keys(DESC)) {
    L.push(`| \`${f}\` | ${DESC[f][0]} | ${DESC[f][1]} |`);
}
L.push('');
L.push('## 四、同义触发词（别名表）');
L.push('');
L.push('后端 `_EMO_ALIAS` 与前端 `js/emotion-keys.js` 的 ALIAS 必须一致。');
L.push('下面是前端别名表按目标键归类的结果（后端同款）：');
L.push('');
const byTarget = {};
for (const [w, t] of Object.entries(keys.ALIAS)) {
    (byTarget[t] = byTarget[t] || []).push(w);
}
for (const t of Object.keys(byTarget).sort()) {
    L.push(`- **[${t}]** ← ${byTarget[t].join('、')}`);
}
L.push('');
L.push('## 五、为什么以前"表情做不出来"');
L.push('');
L.push('两个根因，都已修：');
L.push('');
L.push('1. **参数写在渲染管线之外** → 被 motion 曲线覆盖。');
L.push('   实测：模型 10 个 motion 每一个都动画了全部表情参数（眉毛/脸红/笑眼/嘴型/眼球/头角度）。');
L.push('   pixi-live2d-display 的顺序是 motion 曲线 → saveParameters → 眼动/物理 → model.update（绘制）。');
L.push('   在渲染外写参数，下一帧就被覆盖 → 表情从来没活到被画出来的那一刻。');
L.push('   修法：`js/model-interaction.js` 的 `_installExpressionHook()` 挂在 `afterMotionUpdate` 上，每帧重写。');
L.push('2. **情绪动作用 NORMAL(2) 优先级** → 库里的 `reserve()` 规定 NORMAL 打断不了 NORMAL，');
L.push('   于是第一个情绪动作之后的所有动作一律被拒（模型 motion 是循环的，永远不停）。');
L.push('   修法：改用 FORCE(3)。');
L.push('');

const out = path.join(ROOT, 'docs', 'EXPRESSION_CATALOG.md');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, L.join('\n'), 'utf8');
console.log(`已生成 ${path.relative(ROOT, out)}（${L.length} 行，${map.EXPRESSION_KEYS.length} 个表情）`);
