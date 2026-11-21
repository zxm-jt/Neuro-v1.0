const REAL = {
    winW: 994, winH: 663,
    canvasW: 1491, canvasH: 994,
    widthAtScale1: 2976, heightAtScale1: 4175,
    targetVisibleH: 560,
};
const HIP_RATIO = 0.62;

console.log('真实数据:', JSON.stringify(REAL, null, 2));
console.log();

const ratio = REAL.canvasW / REAL.winW;
console.log('=== 1. 画布倍率 ===');
console.log(`  renderer.width / innerWidth = ${REAL.canvasW}/${REAL.winW} = ${ratio.toFixed(3)}`);
console.log(`  dpr 推算 = ${REAL.winW}x${REAL.winH} 窗口 vs 物理 2880x1620`);
console.log(`  物理/窗口 = ${(2880 / REAL.winW).toFixed(2)}x  <-- 与画布倍率不同！`);
console.log();

console.log('=== 2. 模型原始尺寸是否可信 ===');
console.log(`  scale=1 时读到 ${REAL.widthAtScale1}x${REAL.heightAtScale1}`);
console.log(`  画布 ${REAL.canvasW}x${REAL.canvasH}`);
console.log(`  模型宽/画布宽 = ${(REAL.widthAtScale1 / REAL.canvasW).toFixed(2)}x`);
if (REAL.widthAtScale1 > REAL.canvasW) {
    console.log('  ★ 模型比画布还宽 → 原始尺寸读【错了】，或 scale 算得过小');
}
console.log();

console.log('=== 3. 正确 scale 应该是多少 ===');
const scenarios = [
    { name: 'A. 用 scale=1 读到的 rawH（当前代码）', rawH: REAL.heightAtScale1 },
    { name: 'B. 假设真实 rawH 是画布高的 2.5倍', rawH: REAL.canvasH * 2.5 },
    { name: 'C. 假设真实 rawH = 4175/2.5（被多算了2.5倍）', rawH: REAL.heightAtScale1 / 2.5 },
];
for (const s of scenarios) {
    const fullH = REAL.targetVisibleH / HIP_RATIO;
    let scale = fullH / s.rawH;
    const maxScale = (REAL.canvasH * 0.92) / (s.rawH * HIP_RATIO);
    const capped = scale > maxScale;
    const used = capped ? maxScale : scale;
    const visible = s.rawH * used * HIP_RATIO;
    console.log(`  ${s.name}`);
    console.log(`     rawH=${s.rawH.toFixed(0)} -> scale=${used.toFixed(4)}`
        + (capped ? ' (被画布上限截断)' : ''));
    console.log(`     实际可见高度=${visible.toFixed(0)}px (目标 ${REAL.targetVisibleH}px)`
        + `  ${Math.abs(visible - REAL.targetVisibleH) < 30 ? 'OK' : '★ 偏差大'}`);
}
console.log();

console.log('=== 4. layoutToCorner 的位置计算 ===');
const scale = (REAL.targetVisibleH / HIP_RATIO) / REAL.heightAtScale1;
const dispW = REAL.widthAtScale1 * scale;
const dispH = REAL.heightAtScale1 * scale;
const hipFromTop = dispH * HIP_RATIO;
const margin = -70;
console.log(`  scale=${scale.toFixed(4)}显示尺寸=${dispW.toFixed(0)}x${dispH.toFixed(0)}`);
console.log(`  胯部距顶=${hipFromTop.toFixed(0)}px`);
console.log(`  x = innerWidth - dispW - margin = ${REAL.winW} - ${dispW.toFixed(0)} - (${margin}) = ${(REAL.winW - dispW - margin).toFixed(0)}`);
console.log(`  y = innerHeight - hipFromTop = ${REAL.winH} - ${hipFromTop.toFixed(0)} = ${(REAL.winH - hipFromTop).toFixed(0)}`);
console.log(`  判定：y<0 则被钳到 0 → ${(REAL.winH - hipFromTop < 0) ? '★ 会钳到 0，人物贴到顶部' : '正常'}`);
console.log(`       x<0 则被钳到 -dispW/2 → ${(REAL.winW - dispW - margin < 0) ? '★ 会钳到 -' + (dispW/2).toFixed(0) + '，人物跑到屏幕左外' : '正常'}`);
console.log();

console.log('=== 结论 ===');
if (REAL.heightAtScale1 * (REAL.targetVisibleH / HIP_RATIO) / REAL.heightAtScale1 * HIP_RATIO < REAL.targetVisibleH * 0.5) {
    console.log('  显示尺寸与目标差太远 → scale 计算用的 rawH 不对');
}
console.log('  最可能的原因：model.width/height 是 PIXI 的 getter，');
console.log('  它等于 |scale| × _localBounds。临时 scale.set(1) 之后');
console.log('  _localBounds 尚未按新 transform 重算（updateBounds 是懒的），');
console.log('  于是读到的仍是【上一次 transform 下的世界尺寸】，');
console.log('  而非真正的模型原始尺寸。');
console.log('  → 正确做法：不要用 model.width 反推 scale，改用');
console.log('     getBounds() 在 scale=1 下的结果，或者干脆不反推，');
console.log('     直接给一个经验 scale 让人物铺满胯部以上。');
