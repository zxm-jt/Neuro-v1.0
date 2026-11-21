const fs = require('fs');

function _matchOpenWordTail(buf) {
    const s = String(buf);
    const m = s.match(/[A-Za-z]{1,20}$/);
    if (!m) return '';
    const tail = m[0];
    const before = s.slice(0, s.length - tail.length);
    if (/[.?!,;:]\s*$/.test(before)) return '';
    if (tail.length >= 20) return '';
    return tail;
}
function _matchTrailingPunct(buf) {
    const s = String(buf);
    const m = s.match(/[.,!?;:]+\s*$/);
    return m ? m[0] : '';
}

class P {
    constructor() { this._wordHold = ''; this._punctHold = ''; this.sent = []; this.sentenceBuf = ''; }
    feed(text, verbose) {
        let buf = this._wordHold ? (this._wordHold + text) : String(text);
        this._wordHold = '';
        if (this._tagHoldFake) { buf = this._tagHoldFake + buf; this._tagHoldFake = ''; }

        const wt = _matchOpenWordTail(buf);
        if (wt) {
            this._wordHold = wt;
            buf = buf.slice(0, buf.length - wt.length);
        }
        const pt = _matchTrailingPunct(buf);
        if (pt) {
            this._punctHold = pt;
            buf = buf.slice(0, buf.length - pt.length);
        } else if (this._punctHold) {
            buf = this._punctHold + buf;
            this._punctHold = '';
        }

        if (verbose) {
            console.log(`  in=${JSON.stringify(text)}`);
            console.log(`     wordHold=${JSON.stringify(this._wordHold)} punctHold=${JSON.stringify(this._punctHold)}`);
            console.log(`     buf=${JSON.stringify(buf)}`);
        }
        if (buf.trim()) this.sentenceBuf += buf;
    }
    flush() {
        if (this._wordHold) { this.sentenceBuf += this._wordHold; this._wordHold = ''; }
        if (this._punctHold) { this.sentenceBuf += this._punctHold; this._punctHold = ''; }
        return this.sentenceBuf;
    }
}

const REAL_CHUNKS = [
    "I live in the bottom-right corner, user. That's",
    " my whole brand."
];

console.log('=== 场景A：chunk 边界落在空格之后（空格在 chunk1 末尾）===');
{
    const p = new P();
    for (const c of REAL_CHUNKS) p.feed(c, true);
    const out = p.flush();
    console.log('  结果: ' + JSON.stringify(out));
    console.log('  期望: "I live in the bottom-right corner, user. That\'s my whole brand."');
    console.log('  空格丢失? ' + (out.includes("That\'s my") ? '否 ✓' : '★是'));
}

console.log('\n=== 场景B：chunk 边界落在空格之前（空格在 chunk2 开头）===');
{
    const p = new P();
    const chunks = ["I live in the bottom-right corner, user. That's", " my whole brand."];
    for (const c of chunks) p.feed(c, true);
    const out = p.flush();
    console.log('  结果: ' + JSON.stringify(out));
}

console.log('\n=== 场景C：逐字符吐（最碎的情况）===');
{
    const p = new P();
    const full = "That's my whole brand.";
    for (const ch of full) p.feed(ch, false);
    const out = p.flush();
    console.log('  结果: ' + JSON.stringify(out));
    console.log('  空格丢失? ' + (out.includes("That\'s my") ? '否 ✓' : '★是 —— 丢在: ' + JSON.stringify(out)));
}

console.log('\n=== 场景D：逐字符 + 真实词边（定位确切位置）===');
{
    let buf = "That's my whole brand.";
    let wordHold = '', punctHold = '';
    const trace = [];
    for (const ch of "That's my whole brand.") {
        let b = wordHold ? (wordHold + ch) : ch;
        wordHold = '';
        const wt = _matchOpenWordTail(b);
        if (wt) { wordHold = wt; b = b.slice(0, b.length - wt.length); }
        const pt = _matchTrailingPunct(b);
        if (pt) { punctHold = pt; b = b.slice(0, b.length - pt.length); }
        else if (punctHold) { b = punctHold + b; punctHold = ''; }
        trace.push({ ch, wordHold, punctHold, b });
    }
    const sp = "That's my whole brand.";
    for (let i = 0; i < sp.length; i++) {
        if (sp[i] === ' ') {
            const t = trace[i];
            console.log(`  第${i + 1}字符=' ' → wordHold=${JSON.stringify(t.wordHold)} b=${JSON.stringify(t.b)}`);
            const t2 = trace[i + 1];
            console.log(`     下一字符='${t2.ch}' → wordHold=${JSON.stringify(t2.wordHold)} b=${JSON.stringify(t2.b)}`);
        }
    }
    const finalOut = wordHold ? (punctHold + wordHold) : punctHold;
    console.log(`  最终剩下: ${JSON.stringify(finalOut)}`);
    console.log('  ★ 空格被 wordHold 一起扣住了吗? ' +
        (wordHold.includes(' ') ? '是（这就是根因）' : '否'));
}
