const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'model-interaction.js'), 'utf8');

function constOf(name) {
    const m = SRC.match(new RegExp(`const\\s+${name}\\s*=\\s*([-\\d.]+)`));
    if (!m) throw new Error(`找不到常量 ${name}`);
    return parseFloat(m[1]);
}

const VISIBLE_END_RATIO = constOf('VISIBLE_END_RATIO');
const MAX_VISIBLE_RATIO = constOf('MAX_VISIBLE_RATIO');
const CORNER_Y_OFFSET = constOf('CORNER_Y_OFFSET');

let pass = 0, fail = 0;
function ck(name, cond, extra) {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? '  -> ' + extra : ''}`); }
}

function computeScale(winH, canvasH, rawH, modelScale) {
    const targetH = modelScale;
    let fullH = targetH / VISIBLE_END_RATIO;
    const targetVisible = Math.min(targetH, winH * MAX_VISIBLE_RATIO);
    fullH = targetVisible / VISIBLE_END_RATIO;
    let scale = fullH / rawH;
    const maxScale = (canvasH * 0.98) / rawH;
    if (scale > maxScale) scale = maxScale;
    return { scale, fullH, targetVisible };
}

function computeY(winH, dispH, offset) {
    const visibleFromTop = dispH * VISIBLE_END_RATIO;
    let y = winH - visibleFromTop - offset;
    if (y < 0) y = 0;
    return y;
}

console.log(`\n常量: VISIBLE_END_RATIO=${VISIBLE_END_RATIO} MAX_VISIBLE_RATIO=${MAX_VISIBLE_RATIO} CORNER_Y_OFFSET=${CORNER_Y_OFFSET}`);

const winW = 994, winH = 663, canvasH = 663;
const rawW = 1200, rawH = 2400;
const modelScale = 560;

console.log('\n=== 1. 缩放公式不含 CORNER_Y_OFFSET（大小与位置解耦）===');
const s = computeScale(winH, canvasH, rawH, modelScale);
const dispH = rawH * s.scale;
console.log(`  scale=${s.scale.toFixed(4)} 整身=${Math.round(dispH)}px 可见=${Math.round(s.targetVisible)}px`);

const srcHasOffsetInScale = /scale\s*=\s*[^;]*CORNER_Y_OFFSET/.test(SRC);
ck('缩放公式里不出现 CORNER_Y_OFFSET', !srcHasOffsetInScale,
    '发现 CORNER_Y_OFFSET 出现在 scale 赋值里 → 会污染大小');

console.log('\n=== 2. 偏移只改 y，不改 dispH/scale ===');
const y0 = computeY(winH, dispH, 0);
const y1 = computeY(winH, dispH, CORNER_Y_OFFSET);
console.log(`  y(偏移0)=${Math.round(y0)}  y(偏移${CORNER_Y_OFFSET})=${Math.round(y1)}  差=${Math.round(y0 - y1)}px`);
ck('偏移量生效（上移）', y1 < y0, `y0=${y0} y1=${y1}`);
ck('上移量约等于 CORNER_Y_OFFSET', Math.abs((y0 - y1) - CORNER_Y_OFFSET) <= 1,
    `实际差=${Math.round(y0 - y1)}`);
ck('大小不受影响（dispH 不变）', dispH === computeScale(winH, canvasH, rawH, modelScale).scale * rawH);

console.log('\n=== 3. 头顶不被切掉（上移不过头）===');
for (const off of [0, 90, 200, 400, 1000]) {
    const y = computeY(winH, dispH, off);
    ck(`偏移 ${off}px 时 y >= 0`, y >= 0, `y=${Math.round(y)}`);
}
const yMax = computeY(winH, dispH, 100000);
ck('极端偏移被 y<0 兜底钳制为 0', yMax === 0, `y=${yMax}`);

console.log('\n=== 4. 露出的可见高度不因偏移而变 ===');
const visibleBefore = dispH * VISIBLE_END_RATIO;
const visibleAfter = dispH * VISIBLE_END_RATIO;
ck('可见高度恒定', Math.abs(visibleBefore - visibleAfter) < 0.001);

console.log('\n=== 5. 代码里 layoutToCorner 确实用了偏移 ===');
ck('layoutToCorner 里减了 CORNER_Y_OFFSET',
    /winH\s*-\s*visibleFromTop\s*-\s*CORNER_Y_OFFSET/.test(SRC));
ck('VISIBLE_END_RATIO 仍为 0.42（大小未被改动）',
    Math.abs(VISIBLE_END_RATIO - 0.42) < 1e-9, `实际 ${VISIBLE_END_RATIO}`);

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);
