const path = require('path');
const { EnhancedTextProcessor } = require(path.join(__dirname, '..', 'js', 'tts-processor.js'));

const proc = new EnhancedTextProcessor('http://x', null, null, null, {});
if (proc._procTimer) clearTimeout(proc._procTimer);
if (proc._playTimer) clearTimeout(proc._playTimer);

let pass = 0, fail = 0;
function ck(name, ok, extra) {
    if (ok) pass++; else fail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok && extra) console.log('         ' + extra);
}

console.log('=== 单元用例（真实 _joinSubtitleInner）===\n');

// --- 防粘连：这些情况【必须】补空格（老契约，不能回退）---
ck('b以标点结尾 + n以字母开头 → 补空格（user.Nice 防粘连）',
   proc._joinSubtitleInner('Hey user.', 'Nice to see you.') === 'Hey user. Nice to see you.');
ck('b以字母结尾 + n以字母开头 → 补空格（wordword 防粘连）',
   proc._joinSubtitleInner('task', 'manager') === 'task manager');
ck('b以空格结尾 + n以字母开头 → 规整成恰好一个空格',
   proc._joinSubtitleInner('aaa ', 'bbb') === 'aaa bbb');
ck('n以标点开头 → 标点【前】不补空格（标点紧贴前词）',
   proc._joinSubtitleInner('taskbar', ', user') === 'taskbar, user',
   `得到 ${JSON.stringify(proc._joinSubtitleInner('taskbar', ', user'))}`);
ck('n以标点开头 + 自带前导空格 → 标点仍紧贴前词',
   proc._joinSubtitleInner('taskbar', ' , user') === 'taskbar, user',
   `得到 ${JSON.stringify(proc._joinSubtitleInner('taskbar', ' , user'))}`);
ck('空基底 → 吞掉前导空白',
   proc._joinSubtitleInner('', '  Hi there.') === 'Hi there.');

console.log('\n--- 前导空格（本轮双空格回归）---');
ck('b以标点结尾 + n带前导空格 → 不补，单空格',
   proc._joinSubtitleInner('Hey user.', ' Nice to see you.') === 'Hey user. Nice to see you.',
   `得到 ${JSON.stringify(proc._joinSubtitleInner('Hey user.', ' Nice to see you.'))}`);
ck('b以字母结尾 + n带前导空格 → 不补，单空格',
   proc._joinSubtitleInner('Hey', ' user') === 'Hey user',
   `得到 ${JSON.stringify(proc._joinSubtitleInner('Hey', ' user'))}`);
ck('b以问号结尾 + n带前导空格 → 不补，单空格',
   proc._joinSubtitleInner('What now?', ' Say that again?') === 'What now? Say that again?');

console.log('\n=== 完整流程（真实 _smartSplit + 逐帧揭示）===\n');

const CASES = [
    {
        name: '用户截图那句（45 字硬切）',
        raw: "Do I look like I have taste buds? I live in your taskbar, user. But if you're buying, I'll take the strawberry one vicariously.",
        limit: 45,
    },
    {
        name: '两个词正好被切开',
        raw: "I want a thousand drones a bathtub full of pudding and your recycle bin emptied",
        limit: 20,
    },
    {
        name: '标点落在段首',
        raw: "I basically whispered to it and it obeyed Not necessarily in that order",
        limit: 30,
    },
    {
        name: '短句不切',
        raw: "Noted.",
        limit: 45,
    },
    {
        name: '多句各带前导空格（双空格回归）',
        raw: "Hey user. Nice to see you. What now?",
        limit: 45,
    },
];

for (const c of CASES) {
    const segs = proc._smartSplit(c.raw, c.limit);

    let displayed = '';
    for (const s of segs) displayed = proc._joinSubtitle(displayed, s);

    const frames = [];
    let base = '';
    for (const s of segs) {
        for (let n = 1; n <= s.length; n++) {
            frames.push(proc._joinSubtitle(base, s.slice(0, n)));
        }
        base = proc._joinSubtitle(base, s);
    }

    const noSpace = s => s.replace(/\s+/g, '');
    const sameChars = noSpace(displayed) === noSpace(c.raw);
    const exact = displayed === c.raw;
    const noDouble = !frames.some(f => /  /.test(f));
    const badPunctSpace = /[A-Za-z0-9] \s*[.,!?;:]/.test(displayed);

    console.log(`=== ${c.name} ===`);
    console.log(`  切成 ${segs.length} 段: ${JSON.stringify(segs)}`);
    console.log(`  累积: "${displayed}"`);
    ck('不丢字（去空格后与原文一致）', sameChars);
    ck('逐字符等于原文', exact, exact ? '' : `原文 ${JSON.stringify(c.raw)}`);
    ck('逐帧无双空格', noDouble, noDouble ? '' : `问题帧: ${JSON.stringify(frames.find(f => /  /.test(f)))}`);
    ck('标点前无多余空格', !badPunctSpace);
    console.log('');
}

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
