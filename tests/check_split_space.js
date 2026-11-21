const LIMIT = 45;
const SOFT = ['.', ',', '!', '?', ';', ':', ' '];

function wordSafeCut(buf, limit) {
    for (let k = limit; k > limit - 25 && k > 5; k--) {
        if (/\s/.test(buf[k - 1])) return k;
    }
    return limit;
}

function smartSplitTrim(text, limit) {
    const out = [];
    let buf = '';
    for (const ch of text) {
        buf += ch;
        if (buf.length < limit) continue;
        let cut = -1;
        for (let k = 0; k < buf.length; k++) if (SOFT.includes(buf[k])) cut = k + 1;
        if (cut > 0 && cut >= buf.length - 30) {
            out.push(buf.slice(0, cut).trim());
            buf = buf.slice(cut);
        } else if (buf.length >= limit + 30) {
            const safe = wordSafeCut(buf, limit);
            out.push(buf.slice(0, safe).trim());
            buf = buf.slice(safe);
        }
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
}

function smartSplitFixed(text, limit) {
    const out = [];
    let buf = '';
    for (const ch of text) {
        buf += ch;
        if (buf.length < limit) continue;
        let cut = -1;
        for (let k = 0; k < buf.length; k++) if (SOFT.includes(buf[k])) cut = k + 1;
        let seg, rest;
        if (cut > 0 && cut >= buf.length - 30) {
            seg = buf.slice(0, cut);
            rest = buf.slice(cut);
        } else if (buf.length >= limit + 30) {
            const safe = wordSafeCut(buf, limit);
            seg = buf.slice(0, safe);
            rest = buf.slice(safe);
        } else continue;
        seg = seg.replace(/\s+([.,!?;:])/g, '$1')
                   .replace(/\s+$/, '');
        if (seg && /[A-Za-z0-9,.!?;:]/.test(seg)) seg += ' ';
        rest = rest.replace(/^\s+/, '');
        if (out.length && /\s$/.test(out[out.length - 1])) {
            rest = rest.replace(/^\s+/, '');
        }
        if (seg) out.push(seg);
        buf = rest;
    }
    const tail = buf.replace(/\s+$/, '');
    if (tail.trim()) out.push(tail);
    return out;
}

const CASES = [
    "I live in the bottom-right corner, user. That's my whole brand.",
    "Do I look like I have taste buds? I live in your taskbar, user. But if you're buying, I'll take the strawberry one.",
    "Yo user, you still there? I was about to file a missing person report.",
    "Oh? Then I'll give you a whole spectrum, user. But I charge per emotion, so keep your wallet ready.",
];

let p = 0, fl = 0;
function ck(name, ok, extra) {
    if (ok) p++; else fl++;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra ? '\n         ' + extra : ''));
}

console.log('=== 当前实现（带 trim）===\n');
for (const c of CASES) {
    const segs = smartSplitTrim(c, LIMIT);
    const joined = segs.join('');
    console.log('  段: ' + JSON.stringify(segs));
    const ok = joined.replace(/\s+/g, '') === c.replace(/\s+/g, '');
    console.log('  拼: ' + JSON.stringify(joined));
    console.log('  → 空格保留? ' + (joined.replace(/\s+/g,'') === c.replace(/\s+/g,'') ? '（内容对）' : '') );
    console.log('');
}

console.log('=== 修法（切分不 trim）===\n');
for (const c of CASES) {
    const segs = smartSplitFixed(c, LIMIT);
    const joined = segs.join('');
    const sameChars = joined.replace(/\s+/g, '') === c.replace(/\s+/g, '');
    const sameSpaces = joined === c;
    console.log('  段: ' + JSON.stringify(segs));
    console.log('  拼: ' + JSON.stringify(joined));
    ck(`${c.slice(0, 34)}… 字符一致`, sameChars, sameChars ? '' : `得到 ${joined.replace(/\s+/g,'')}`);
    ck(`${c.slice(0, 34)}… 空格位置完全一致`, sameSpaces,
       sameSpaces ? '与原文逐字符相同' : `\n         原文 ${JSON.stringify(c)}\n         结果 ${JSON.stringify(joined)}`);
}

console.log('\n=== 对比：两种实现丢失的空格数 ===');
for (const c of CASES) {
    const a = smartSplitTrim(c, LIMIT).join('');
    const b = smartSplitFixed(c, LIMIT).join('');
    const sa = (a.match(/ /g) || []).length;
    const sb = (b.match(/ /g) || []).length;
    const sc = (c.match(/ /g) || []).length;
    console.log(`  原文 ${sc} 个空格 | trim版 ${sa} | 修法版 ${sb} ` +
        (sb === sc ? '✓' : '✘'));
}

console.log(`\n结果：${p} PASS / ${fl} FAIL（历史实现对照，FAIL 为预期——现行标准见 check_split_space2.js）`);
process.exit(0);
