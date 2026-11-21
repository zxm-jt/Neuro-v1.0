const { CANONICAL, normalizeEmotionKey, pickFallbackGroup } = require('../js/emotion-keys.js');

let pass = 0, fail = 0;
function ck(name, ok, extra) {
    if (ok) pass++; else fail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n         ' + extra}`);
}

console.log('=== 情绪词规范化 ===\n');

for (const k of CANONICAL) {
    ck(`规范键直通: ${k}`, normalizeEmotionKey(k) === k, normalizeEmotionKey(k));
}

const aliasCases = [
    ['cheerful', 'happy'], ['happily', 'happy'], ['glad', 'happy'],
    ['glee', 'joy'], ['joyful', 'joy'], ['stoked', 'excited'], ['hype', null],
    ['smiley', 'smile'], ['adore', 'love'],
    ['blush', 'blush'],
    ['gloomy', 'sad'], ['teary', 'cry'], ['puzzled', 'confused'],
    ['curious', 'curious'], ['concerned', 'concerned'],
    ['anxious', 'worried'], ['shocked', 'shock'],
    ['astonished', 'surprised'], ['furious', 'angry'], ['rage', 'angry'],
    ['grumpy', 'annoyed'], ['envious', 'jealous'], ['smirking', 'smug'],
    ['[Happy]', 'happy'], ['  ANGRY  ', 'angry'], ['very emotional', null],
];
for (const [inp, want] of aliasCases) {
    ck(`别名: "${inp}" → ${want}`, normalizeEmotionKey(inp) === want, normalizeEmotionKey(inp));
}

ck('后缀剥离: joyfully → joy', normalizeEmotionKey('joyfully') === 'joy', normalizeEmotionKey('joyfully'));
ck('后缀剥离: angrily → angry', normalizeEmotionKey('angrily') === 'angry', normalizeEmotionKey('angrily'));
ck('后缀剥离: maddening → mad', normalizeEmotionKey('maddening') === 'mad', normalizeEmotionKey('maddening'));
ck('后缀+前缀: happily → happy', normalizeEmotionKey('happily') === 'happy', normalizeEmotionKey('happily'));

ck('前缀: happ → happy', normalizeEmotionKey('happ') === 'happy', normalizeEmotionKey('happ'));
ck('前缀: sadn → sad', normalizeEmotionKey('sadn') === 'sad', normalizeEmotionKey('sadn'));
ck('前缀: exci → excited', normalizeEmotionKey('exci') === 'excited', normalizeEmotionKey('exci'));

const zhCases = [['开心', 'happy'], ['兴奋', 'excited'], ['生气', 'angry'],
                 ['难过', 'sad'], ['担心', 'worried'], ['惊讶', 'surprised'], ['嫉妒', 'jealous']];
for (const [inp, want] of zhCases) {
    ck(`中文: ${inp} → ${want}`, normalizeEmotionKey(inp) === want, normalizeEmotionKey(inp));
}

// 6) 折不了 → null（不能瞎猜，兜底交给调用方）
ck('折不了: banana → null', normalizeEmotionKey('banana') === null, normalizeEmotionKey('banana'));
ck('折不了: 空串 → null', normalizeEmotionKey('') === null);
ck('折不了: null → null', normalizeEmotionKey(null) === null);

const defs = { Idle: [1], Cheer: [1, 2], Think: [3] };
ck('回退: 排除 Idle 和指定组', ['Cheer', 'Think'].includes(pickFallbackGroup(defs, 'Cheer')), pickFallbackGroup(defs, 'Cheer'));
ck('回退: 只剩 Idle 时也给 Idle', pickFallbackGroup({ Idle: [1] }, null) === 'Idle');
ck('回退: 空定义 → null', pickFallbackGroup({}, null) === null);
ck('回退: null 定义 → null', pickFallbackGroup(null, null) === null);
ck('回退: 空数组组被跳过', pickFallbackGroup({ Idle: [], Cheer: [] }, null) === null);
// 多次抽样必须只落在合法组里
let okSample = true;
for (let i = 0; i < 50; i++) {
    const g = pickFallbackGroup(defs, null);
    if (g !== 'Cheer' && g !== 'Think') { okSample = false; break; }
}
ck('回退: 50 次抽样全合法', okSample);

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
