const fs = require('fs');
const path = require('path');
const SR = 48000;
const WIN = 15360;

function makeCtx() {
    return {
        micSampleRate: SR,
        _noiseTemplate: null,
        _noiseBins: 0,
        _noiseLearnMs: 0,
        _noiseFrozen: false,
        _spectrum(buf, from, to) {
            const n = to - from;
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
                if (i < j) {
                    const t = re[i]; re[i] = re[j]; re[j] = t;
                    const u = im[i]; im[i] = im[j]; im[j] = u;
                }
            }
            for (let len = 2; len <= size; len <<= 1) {
                const ang = -2 * Math.PI / len;
                const wr = Math.cos(ang), wi = Math.sin(ang);
                for (let i = 0; i < size; i += len) {
                    let cr = 1, ci = 0;
                    for (let k = 0; k < len / 2; k++) {
                        const ar = re[i + k], ai = im[i + k];
                        const br = re[i + k + len / 2], bi = im[i + k + len / 2];
                        const vr = br * cr - bi * ci;
                        const vi = br * ci + bi * cr;
                        re[i + k] = ar + vr; im[i + k] = ai + vi;
                        re[i + k + len / 2] = ar - vr; im[i + k + len / 2] = ai - vi;
                        const ncr = cr * wr - ci * wi;
                        ci = cr * wi + ci * wr; cr = ncr;
                    }
                }
            }
            const mag = new Float32Array(half);
            for (let i = 0; i < half; i++) mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
            return { size, half, mag, hzPerBin: SR / size };
        },
        _learnNoise(buf, from, to) {
            if (this._noiseFrozen) return;
            const sp = this._spectrum(buf, from, to);
            const bins = sp.half;
            if (!this._noiseTemplate || this._noiseBins !== bins) {
                this._noiseTemplate = Float32Array.from(sp.mag);
                this._noiseBins = bins;
                this._noiseLearnMs = 0;
                return;
            }
            const a = 0.12, t = this._noiseTemplate;
            for (let i = 0; i < bins; i++) t[i] = t[i] * (1 - a) + sp.mag[i] * a;
            this._noiseLearnMs += (to - from) / SR * 1000;
        },
        _spectralSubtractRatio(buf, from, to) {
            if (!this._noiseTemplate || this._noiseBins === 0 || this._noiseLearnMs < 400) {
                return { ratio: 1, snrDb: 99, learned: false };
            }
            const sp = this._spectrum(buf, from, to);
            if (sp.half !== this._noiseBins) return { ratio: 1, snrDb: 99, learned: false };
            const lo = Math.max(1, Math.floor(80 / sp.hzPerBin));
            const hi = Math.min(sp.half - 1, Math.ceil(4000 / sp.hzPerBin));
            if (hi <= lo) return { ratio: 1, snrDb: 99, learned: false };
            const t = this._noiseTemplate;
            let before = 0, after = 0;
            for (let i = lo; i <= hi; i++) {
                const p = sp.mag[i] * sp.mag[i];
                before += p;
                const r = sp.mag[i] - t[i] * 1.0;
                const c = r > t[i] * 0.3 ? r : 0;
                after += c * c;
            }
            if (before < 1e-12) return { ratio: 0, snrDb: -99, learned: true };
            const ratio = after / before;
            return { ratio, snrDb: 10 * Math.log10(Math.max(ratio, 1e-9)), learned: true };
        },
    };
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
              + 0.10 * Math.sin(2 * Math.PI * 1180 * t + 1.1)
              + 0.30 * rnd()
              + 0.12 * Math.sin(2 * Math.PI * 4100 * t + 0.3);
        } else {
            v = 0.25 * Math.sin(2 * Math.PI * 110 * t)
              + 0.45 * rnd()
              + 0.22 * Math.sin(2 * Math.PI * 5200 * t + 1.5);
        }
        out[i] = v;
    }
    let e = 0;
    for (let i = 0; i < out.length; i++) e += out[i] * out[i];
    const k = 0.20 / Math.sqrt(e / out.length);
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

function mix(fan, voice, voiceGain) {
    const n = Math.min(fan.length, voice.length);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = fan[i] + (voice[i] || 0) * voiceGain;
    return out;
}

function run(fanAudio, testAudio, label, isVoice) {
    const ctx = makeCtx();
    for (let st = 0; st + WIN <= fanAudio.length; st += WIN) {
        ctx._learnNoise(fanAudio, st, st + WIN);
    }
    const r = ctx._spectralSubtractRatio(testAudio, 0, Math.min(WIN, testAudio.length));
    return { label, isVoice, ratio: r.ratio, snrDb: r.snrDb, learned: r.learned, ctx };
}

const fanB = makeFan('broadband', 8, 6789);
const fanW = makeFan('worst', 8, 24680);

const ROOT = process.cwd();
const voiceFiles = ['_archive/试听样本/10_ZH_angry.wav', '_archive/试听样本/11_ZH_sad_slow.wav'];
const voices = [];
for (const f of voiceFiles) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) voices.push({ name: path.basename(f), data: readWav(p) });
}

console.log('=== 噪声模板 + 谱减：SNR 判别力===\n');
console.log('【学完噪声模板后，判别各类音频的 SNR】');
console.log('  (风扇应该 ≪ 0dB，人声应该 ≫ 0dB)\n');

const results = [];
for (const [nm, a] of [['clean 理想化', makeFan('clean', 6, 1)],
                        ['broadband 真实风扇', fanB],
                        ['worst 轴承尖啸', fanW]]) {
    const r = run(fanB, a, nm, false);
    results.push(r);
    console.log(`  ${nm.padEnd(22)} SNR=${r.snrDb.toFixed(1).padStart(7)}dB  ratio=${(r.ratio*100).toFixed(1).padStart(5)}%  ${r.isVoice ? '' : '→ 应挡'}`);
}
console.log('');
for (const v of voices) {
    const r = run(fanB, v.data, v.name, true);
    results.push(r);
    console.log(`  ${v.name.padEnd(22)} SNR=${r.snrDb.toFixed(1).padStart(7)}dB  ratio=${(r.ratio*100).toFixed(1).padStart(5)}%  → 应过`);
}
console.log('');
console.log('【★真实场景：风扇开着的时候说话】');
for (const v of voices) {
    for (const gain of [1.0, 0.5, 0.25]) {
        const mixed = mix(fanB, v.data, gain);
        const ctx = results.find(r => r.label === v.name).ctx;
        const from = Math.floor(WIN);
        const r = ctx._spectralSubtractRatio(mixed, from, from + WIN);
        let e = 0;
        for (let i = 0; i < mixed.length; i++) e += mixed[i] * mixed[i];
        const rms = Math.sqrt(e / mixed.length);
        console.log(`  ${v.name.slice(0,12).padEnd(12)} 增益${gain.toFixed(2)} (混合rms=${rms.toFixed(3)})  `
            + `SNR=${r.snrDb.toFixed(1).padStart(7)}dB  ratio=${(r.ratio*100).toFixed(1).padStart(5)}%`);
    }
}

console.log('\n=== 阈值选择（判别量= ratio，越大越像人声）===');
const noiseRatio = results.filter(r => !r.isVoice).map(r => r.ratio * 100);
const nMax = Math.max(...noiseRatio);
console.log(`  风扇 ratio 最高 = ${nMax.toFixed(1)}%`);
console.log('  【人声用混合音测】风扇开着说话时的 ratio：');
const voiceRatio = [];
for (const v of voices) {
    for (const gain of [1.0, 0.5, 0.25]) {
        const mixed = mix(fanB, v.data, gain);
        const ctx = results.find(r => r.label === v.name).ctx;
        const from = Math.floor(WIN);
        const r = ctx._spectralSubtractRatio(mixed, from, from + WIN);
        voiceRatio.push(r.ratio * 100);
    }
}
const vMin = Math.min(...voiceRatio);
console.log(`  人声 ratio 最低 = ${vMin.toFixed(1)}%（增益0.25 时——最难的case）`);
console.log(`  间隔 = ${(vMin - nMax).toFixed(1)} 个百分点`);
const suggest = (nMax + vMin) / 2;
console.log(`  建议阈值（中点）= ${suggest.toFixed(1)}% = ${(suggest/100).toFixed(3)}`);
console.log(nMax < vMin
    ? `  ✔ 有清晰分界（${nMax.toFixed(1)}% < ${suggest.toFixed(1)}% < ${vMin.toFixed(1)}%）→ 方法有效`
    : '  ✘ 无分界 → 方法无效，换思路');

console.log('\n=== 对照：真实的 _learnNoise / _spectralSubtractRatio ===\n');
let rp = 0, rf = 0;
function rck(name, ok, extra) {
    if (ok) rp++; else rf++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n         ' + extra}`);
}
try {
    const { ASRProcessor } = require(path.join(process.cwd(), 'js', 'asr-processor.js'));
    const proc = new ASRProcessor('http://x', 'http://x', null);
    rck('micSampleRate 默认 48000（与测试假设一致）', proc.micSampleRate === 48000,
        `实际 ${proc.micSampleRate}`);

    for (let st = 0; st + WIN <= fanB.length; st += WIN) proc._learnNoise(fanB, st, st + WIN);
    rck('学完 8s 风扇后 learned=true（超过 400ms 门限）',
        proc._spectralSubtractRatio(fanB, 0, WIN).learned === true);

    // 真实代码上的分界：风扇必须 < 30% < 人声（阈值语义同 SPECTRAL_VOICE_MIN）
    let realFanMax = 0;
    for (const [nm, a] of [['clean', makeFan('clean', 6, 1)], ['broadband', fanB], ['worst', fanW]]) {
        const r = proc._spectralSubtractRatio(a, 0, WIN);
        realFanMax = Math.max(realFanMax, r.ratio);
        rck(`真实代码挡下 ${nm}（ratio=${(r.ratio * 100).toFixed(1)}% < 30%）`, r.ratio < 0.30);
    }
    let realVoiceMin = 1;
    for (const v of voices) {
        for (const gain of [1.0, 0.5, 0.25]) {
            const mixed = mix(fanB, v.data, gain);
            const r = proc._spectralSubtractRatio(mixed, Math.floor(WIN), Math.floor(WIN) + WIN);
            realVoiceMin = Math.min(realVoiceMin, r.ratio);
        }
    }
    rck(`真实代码不漏人声（最低 ${(realVoiceMin * 100).toFixed(1)}% > 30%）`, realVoiceMin > 0.30);
    rck('真实代码上分界清晰（风扇最高 < 人声最低）', realFanMax < realVoiceMin,
        `风扇 ${(realFanMax * 100).toFixed(1)}% vs 人声 ${(realVoiceMin * 100).toFixed(1)}%`);

    // 冻结契约：录音期间 _noiseFrozen=true 必须挡住学习（否则把人声学进模板）
    proc._noiseFrozen = true;
    const before = proc._noiseTemplate[10];
    for (let st = 0; st + WIN <= fanB.length; st += WIN) proc._learnNoise(fanB, st, st + WIN);
    rck('_noiseFrozen=true 时 _learnNoise 不更新模板', proc._noiseTemplate[10] === before);
    proc._noiseFrozen = false;
} catch (e) {
    console.log('  ★ 无法导入 asr-processor.js: ' + e.message);
    rf++;
}
console.log(`\n真实代码对照: ${rp} PASS / ${rf} FAIL`);
process.exit(rf > 0 ? 1 : 0);
