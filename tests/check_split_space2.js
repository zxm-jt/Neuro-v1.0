const path = require('path');

const LIMIT = 45;
const SOFT = ['.', ',', '!', '?', ';', ':', ' '];
const PUNCT = new Set(['.', ',', '!', '?', ';', ':']);

function wordSafeCut(buf, limit) {
    for (let k = limit; k > limit - 25 && k > 5; k--) {
        if (/\s/.test(buf[k - 1])) return k;
    }
    return limit;
}

function split(text, limit) {
    const out = [];
    let buf = '';
    for (let i = 0; i < text.length; i++) {
        buf += text[i];
        if (buf.length < limit) continue;

        let cut = -1;
        for (let k = 0; k < buf.length; k++) {
            if (SOFT.includes(buf[k])) cut = k + 1;
        }

        let rawSeg, rest, removed;
        if (cut > 0 && cut >= buf.length - 30) {
            rawSeg = buf.slice(0, cut);
            rest = buf.slice(cut);
            removed = rawSeg[rawSeg.length - 1];
        } else if (buf.length >= limit + 30) {
            const safe = wordSafeCut(buf, limit);
            rawSeg = buf.slice(0, safe);
            rest = buf.slice(safe);
            removed = ' ';
        } else {
            continue;
        }

        const lastCh = rawSeg[rawSeg.length - 1];
        let seg = rawSeg.replace(/\s+$/, '');
        if (PUNCT.has(lastCh)) {
            seg = seg.replace(/\s+([.,!?;:])/g, '$1');
            rest = rest.replace(/^\s*/, match => match);
        } else {
            if (seg) seg += ' ';
            rest = rest.replace(/^\s+/, '');
        }

        if (seg) out.push(seg);
        buf = rest;
    }

    const tail = buf.replace(/\s+$/, '');
    if (tail.trim()) out.push(tail);
    return out;
}

function splitV2(text, limit) {
    const out = [];
    let start = 0;
    let end = 0;

    while (start < text.length) {
        if (text.length - start <= limit) { end = text.length; break; }

        const searchEnd = Math.min(text.length, start + limit + 30);
        let cut = -1;
        for (let k = start; k < searchEnd; k++) {
            if (SOFT.includes(text.charAt(k))) cut = k + 1;
        }
        if (cut < 0 || cut < start + limit - 25) {
            cut = -1;
            for (let k = start + limit; k > start + 5 && k > start + limit - 25; k--) {
                if (/\s/.test(text.charAt(k - 1))) { cut = k; break; }
            }
            if (cut < 0) cut = Math.min(text.length, start + limit);
        }
        end = cut;
        // ---- 唯一要做的规整：段内标点前不留空格（切分副作用）----
        const seg = text.slice(start, end).replace(/\s+([.,!?;:])/g, '$1');
        if (seg.trim()) out.push(seg);
        start = end;
    }

    const tail = text.slice(start).replace(/\s+([.,!?;:])/g, '$1');
    if (tail.trim()) out.push(tail);
    return out;
}

let pass = 0, fail = 0;
function ck(name, ok, extra) {
    if (ok) pass++; else fail++;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra ? '\n         ' + extra : ''));
}

const CASES = [
    "I live in the bottom-right corner, user. That's my whole brand.",
    "Do I look like I have taste buds? I live in your taskbar, user. But if you're buying, I'll take the strawberry one.",
    "Yo user, you still there? I was about to file a missing person report.",
    "Oh? Then I'll give you a whole spectrum, user. But I charge per emotion, so keep your wallet ready.",
    "Is that a bribe? Because it's working. Strawberry or mint? Choose wisely, user.",
    "user, are you still alive? Your mouse is moving, so I know you're plotting something.",
    "I want a thousand drones, a bathtub full of pudding, and your recycle bin emptied. Not necessarily in that order.",
    "Morning, user. I definitely wasn't waiting up for you-I've just been aggressively negotiating with the sunrise over who gets to glow brighter.",
];

console.log('=== 逐句验证（join(  ) 后必须与原文逐字符相同）===\n');
for (const c of CASES) {
    const segs = splitV2(c, LIMIT);
    const joined = segs.join('');
    const exact = joined === c;
    console.log('  原文: ' + JSON.stringify(c));
    console.log('  段  : ' + JSON.stringify(segs));
    console.log('  拼  : ' + JSON.stringify(joined));
    ck(exact ? '逐字符一致 ✓' : '不一致', exact,
       exact ? '' : '\n         差异位置: ' + (() => {
           for (let i = 0; i < Math.max(joined.length, c.length); i++) {
               if (joined[i] !== c[i]) return `第${i + 1}字原文=${JSON.stringify(c[i])} 结果=${JSON.stringify(joined[i])}`;
           }
           return '长度不同';
       })());
    console.log('');
}

console.log('=== 空格数量核对 ===');
for (const c of CASES) {
    const a = split(c, LIMIT).join('');
    const b = splitV2(c, LIMIT).join('');
    const sc = (c.match(/ /g) || []).length;
    console.log(`  原文${String(sc).padStart(3)} | v1 ${String((a.match(/ /g) || []).length).padStart(3)} `
        + `| v2 ${String((b.match(/ /g) || []).length).padStart(3)} `
        + `${b === c ? '✓ 逐字符相同' : '✘'}`);
}

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);

console.log('\n=== 对照：真实的 _smartSplit（从 js/tts-processor.js 导入）===\n');
let rp = 0, rf = 0;
try {
    const { EnhancedTextProcessor } = require(path.join(__dirname, '..', 'js', 'tts-processor.js'));
    const proc = new EnhancedTextProcessor('http://x', null, null, null, {});
    if (proc._procTimer) clearTimeout(proc._procTimer);
    if (proc._playTimer) clearTimeout(proc._playTimer);
    for (const c of CASES) {
        const segs = proc._smartSplit(c);
        const joined = segs.join('');
        const exact = joined === c;
        if (exact) rp++; else rf++;
        console.log(`  ${exact ? 'PASS' : 'FAIL'} ${JSON.stringify(c.slice(0, 42))}…`);
        if (!exact) {
            console.log(`         原文 ${JSON.stringify(c)}`);
            console.log(`         结果 ${JSON.stringify(joined)}`);
            for (let i = 0; i < Math.max(joined.length, c.length); i++) {
                if (joined[i] !== c[i]) {
                    console.log(`         差异: 第${i + 1}字 原文=${JSON.stringify(c[i])} 结果=${JSON.stringify(joined[i])}`);
                    break;
                }
            }
        }
    }
    console.log(`\n真实 _smartSplit: ${rp} PASS / ${rf} FAIL`);
} catch (e) {
    console.log('  ★ 无法导入 tts-processor.js: ' + e.message);
}
process.exit(fail + rf > 0 ? 1 : 0);
