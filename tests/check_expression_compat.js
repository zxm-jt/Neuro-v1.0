'use strict';
const path = require('path');
const { EXPRESSIONS } = require(path.join(__dirname, '..', 'js', 'expression-map.js'));

let pass = 0, fail = 0;
function ok(name, cond) {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ ' + name); }
}

const STRIP_EMO_RE = /[\[【]\s*[A-Za-z0-9_ \-\u4e00-\u9fff]{1,40}?\s*[\]】]/g;
function stripForSubtitle(t) {
    return String(t)
        .replace(STRIP_EMO_RE, '')
        .replace(/\s+([,;:.!?，。；：！？])/g, '$1')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}
console.log('[A] 字幕剥离');
ok('去掉 [thoughtful]', stripForSubtitle('[thoughtful] I can see it...') === 'I can see it...');
ok('去掉中文【害羞】', stripForSubtitle('【害羞】 嗯…') === '嗯…');
ok('保留全角圆括号提示', stripForSubtitle('（你打断了她）') === '（你打断了她）');
ok('保留 用户: 前缀', stripForSubtitle('用户: 你在看什么') === '用户: 你在看什么');
ok('保留普通标点句', stripForSubtitle('加载失败：网络错误') === '加载失败：网络错误');
ok('行内标签也去掉', stripForSubtitle('I [happy] love this') === 'I love this');

console.log('[B] 眉头内角角度(bA) 符号');
const NEG_OK = ['thoughtful', 'curious', 'concerned', 'sad', 'cry', 'confused', 'thinking', 'worried', 'shock',
                'happy', 'joy', 'excited', 'smile', 'love', 'blush', 'gentle_smile', 'starry_eyes', 'playful', 'bored'];
const POS_OK = ['angry', 'mad', 'annoyed', 'jealous'];
for (const k of NEG_OK) {
    const p = (EXPRESSIONS[k] && EXPRESSIONS[k].params) || {};
    if ('bA' in p) ok(`${k}.bA 应为负或零 (现=${p.bA})`, p.bA <= 0);
}
for (const k of POS_OK) {
    const p = (EXPRESSIONS[k] && EXPRESSIONS[k].params) || {};
    if ('bA' in p) ok(`${k}.bA 应为正 (现=${p.bA})`, p.bA > 0);
}

const th = EXPRESSIONS.thoughtful.params;
ok('thoughtful.mouth 不再下撇(>=0)', th.mouth >= 0);
ok('thoughtful.bL 上挑(>=0)', th.bL >= 0);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
