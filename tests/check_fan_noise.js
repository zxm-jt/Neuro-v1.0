const fs = require('fs');
const path = require('path');
const SR = 48000;
const WIN = 15360;

function ratio(buf, from, to) {
    const n = to - from;
    if (n < 256) return 0;
    let size = 512;
    while (size * 2 <= n && size < 4096) size *= 2;
    const half = size >> 1;
    const re = new Float32Array(size), im = new Float32Array(size);
    for (let i = 0; i < size; i++) {
        const k = from + i;
        const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
        re[i] = (k < to ? (buf[k] || 0) : 0) * win;
    }
    for (let i = 1, j = 0; i < size; i++) {
        let bit = size >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
    }
    for (let len = 2; len <= size; len <<= 1) {
        const ang = -2 * Math.PI / len;
        const wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < size; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const ur = re[i + k], ui = im[i + k];
                const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
                const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
                re[i + k] = ur + vr; im[i + k] = ui + vi;
                re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
                const ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr; cr = ncr;
            }
        }
    }
    const hzPerBin = SR / size;
    const lo = Math.max(1, Math.floor(700 / hzPerBin));
    const hi = Math.min(half - 1, Math.ceil(3500 / hzPerBin));
    if (hi <= lo) return 0;
    let band = 0, total = 0;
    for (let i = 1; i < half; i++) {
        const mag = re[i] * re[i] + im[i] * im[i];
        total += mag;
        if (i >= lo && i <= hi) band += mag;
    }
    return total > 1e-9 ? band / total : 0;
}

function makeFan(kind, secs, seed) {
    const out = new Float32Array(Math.floor(secs * SR));
    let s = seed >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; };
    for (let i = 0; i < out.length; i++) {
        const t = i / SR;
        let v;
        if (kind === 'clean') {
            v = 0.6 * Math.sin(2 * Math.PI * 120 * t)
              + 0.3 * Math.sin(2 * Math.PI * 360 * t)
              + 0.15 * Math.sin(2 * Math.PI * 600 * t);
        } else if (kind === 'broadband') {
            v = 0.35 * Math.sin(2 * Math.PI * 118 * t)
              + 0.18 * Math.sin(2 * Math.PI * 236 * t + 0.6)
              + 0.10 * Math.sin(2 * Math.PI * 1180 * t + 1.1);
            v += 0.30 * rnd();
            v += 0.12 * Math.sin(2 * Math.PI * 4100 * t + 0.3);
        } else {
            v = 0.25 * Math.sin(2 * Math.PI * 110 * t)
              + 0.45 * rnd()
              + 0.22 * Math.sin(2 * Math.PI * 5200 * t + 1.5);
        }
        out[i] = v;
    }
    let e = 0;
    for (let i = 0; i < out.length; i++) e += out[i] * out[i];
    const cur = Math.sqrt(e / out.length);
    const k = 0.20 / cur;
    for (let i = 0; i < out.length; i++) out[i] *= k;
    return out;
}

function readWav(p) {
    const b = fs.readFileSync(p);
    let off = 12, dataOff = -1, dataLen = 0, fmt = null;
    while (off < b.length - 8) {
        const id = b.toString('ascii', off, off + 4), sz = b.readUInt32LE(off + 4);
        if (id === 'fmt ') fmt = { ch: b.readUInt16LE(off + 10), sr: b.readUInt32LE(off + 12) };
        else if (id === 'data') { dataOff = off + 8; dataLen = sz; }
        off += 8 + sz + (sz % 2);
    }
    const raw = [];
    for (let i = 0; i < dataLen / 2; i++) raw.push(b.readInt16LE(dataOff + i * 2) / 32768);
    let s = raw;
    if (fmt.ch > 1) {
        const n = Math.floor(raw.length / fmt.ch), o = new Float32Array(n);
        for (let i = 0; i < n; i++) { let a = 0; for (let c = 0; c < fmt.ch; c++) a += raw[i * fmt.ch + c]; o[i] = a / fmt.ch; }
        s = o;
    }
    if (fmt.sr !== SR) {
        const rr = fmt.sr / SR, n = Math.floor(s.length / rr), o = new Float32Array(n);
        for (let i = 0; i < n; i++) o[i] = s[Math.min(Math.floor(i * rr), s.length - 1)];
        return o;
    }
    return Float32Array.from(s);
}

function stats(data, label, isVoice) {
    const vals = [];
    for (let st = 0; st + WIN <= data.length; st += WIN) {
        const r = ratio(data, st, st + WIN);
        if (r > 0.001) vals.push(r * 100);
    }
    if (!vals.length) { console.log(`  ${label.padEnd(24)} 无有效帧`); return null; }
    vals.sort((a, b) => a - b);
    const pc = p => vals[Math.min(vals.length - 1, Math.floor(vals.length * p))];
    console.log(`  ${label.padEnd(24)} 帧${String(vals.length).padStart(3)} `
        + `p05=${pc(0.05).toFixed(1).padStart(5)}% p50=${pc(0.5).toFixed(1).padStart(5)}% `
        + `p95=${pc(0.95).toFixed(1).padStart(5)}%  max=${vals[vals.length-1].toFixed(1)}%`);
    return vals;
}

console.log('=== 现有判据（700~3500Hz 占比，阈值 5%）在真实风扇面前 ===\n');
console.log('【风扇模型】');
const fanClean = stats(makeFan('clean', 4, 12345), 'clean 理想化(旧测试用)', false);
const fanBroad = stats(makeFan('broadband', 4, 6789), 'broadband 真实风扇', false);
const fanWorst = stats(makeFan('worst', 4, 24680), 'worst 轴承尖啸', false);

console.log('\n【真实人声】');
const ROOT = process.cwd();
const voiceFiles = [
    '_archive/试听样本/10_ZH_angry.wav',
    '_archive/试听样本/11_ZH_sad_slow.wav',
];
const voiceStats = [];
for (const f of voiceFiles) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) { console.log('  缺少 ' + f); continue; }
    const v = stats(readWav(p), path.basename(f), true);
    if (v) voiceStats.push(...v);
}

console.log('\n=== 判定 ===');
const TH = 5.0;
function judge(name, vals) {
    if (!vals) return;
    const pass = vals.filter(v => v >= TH).length;
    console.log(`  ${name.padEnd(24)} 过阈值 ${pass}/${vals.length} 帧 `
        + `(${vals.length ? (pass / vals.length * 100).toFixed(0) : 0}%)  → ${pass > vals.length * 0.2 ? '会被当人声 ★漏' : '被挡住'}`);
}
console.log(`（当前阈值 ${TH}%，过阈值率 >20% 就说明会被误判成有人说话）\n`);
judge('clean 理想化', fanClean);
judge('broadband 真实风扇', fanBroad);
judge('worst 轴承尖啸', fanWorst);
if (voiceStats.length) {
    const pass = voiceStats.filter(v => v >= TH).length;
    console.log(`  ${'真实人声'.padEnd(24)} 过阈值 ${pass}/${voiceStats.length} 帧 `
        + `(${(pass / voiceStats.length * 100).toFixed(0)}%)  → ${pass / voiceStats.length > 0.3 ? '能识别 ★没漏人' : '★漏人声了'}`);
}
