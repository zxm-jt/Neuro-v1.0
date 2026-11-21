const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'styles.css'), 'utf8');

const m = css.match(/#subtitle-container\s*\{([\s\S]*?)\n\}/);
if (!m) {
    console.error('✗ 找不到 #subtitle-container 规则块');
    process.exit(1);
}
const block = m[1];

// 取出每个属性（去掉注释行，避免匹配到注释里的内容）
const decls = {};
for (const line of block.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('/*') || t.startsWith('*') || t.startsWith('//')) continue;
    const kv = t.match(/^([a-z-]+)\s*:\s*(.+?)(?:;|\s+\/\*)/i);
    if (kv) decls[kv[1].toLowerCase()] = kv[2].trim().replace(/;$/, '').trim();
}

console.log('=== #subtitle-container 实际生效的声明 ===');
for (const [k, v] of Object.entries(decls)) {
    console.log(`  ${k}: ${v}`);
}

console.log('\n=== 底部对齐三要素检查 ===');
const checks = [
    ['bottom 定位贴屏幕下沿', decls.bottom === '0'],
    ['display 为 none（初始隐藏）', decls.display === 'none'],
    ['flex-direction: column', decls['flex-direction'] === 'column'],
    ['justify-content: flex-end（★关键）', decls['justify-content'] === 'flex-end'],
    ['max-height 有兜底（92vh）', /92vh/.test(decls['max-height'] || '')],
    ['overflow-y: auto（超长可滚）', decls['overflow-y'] === 'auto'],
];
let pass = 0, fail = 0;
for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    ok ? pass++ : fail++;
}

console.log('\n=== 反向检查：不该再有 top 定位 ===');
const hasTop = 'top' in decls;
console.log(`  ${hasTop ? 'FAIL' : 'PASS'}  没有 top 属性（top 会让内容从顶边往下排）`);
if (hasTop) fail++; else pass++;

console.log('\n=== JS 侧：display 必须设 flex ===');
const app = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const setFlex = app.includes("container.style.display = 'flex'");
const setBlock = app.includes("container.style.display = 'block'");
console.log(`  ${setFlex ? 'PASS' : 'FAIL'}  showSubtitle 里设了 'flex'`);
if (!setFlex) fail++; else pass++;
console.log(`  ${setBlock ? 'FAIL' : 'PASS'}  没有残留的 'block'（会覆盖 flex 让贴底失效）`);
if (setBlock) fail++; else pass++;

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
if (fail === 0) {
    console.log('\n预期行为：');
    console.log('  · 容器底边永远在屏幕最下沿（bottom:0）');
    console.log('  · 文字行数增加时，整块往上长（justify-content:flex-end）');
    console.log('  · 最后一行紧贴屏幕底边，不留空隙');
}
process.exit(fail > 0 ? 1 : 0);
