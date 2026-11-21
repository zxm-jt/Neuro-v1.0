const fs = require('fs');
const path = require('path');

const TARGET_SR = 16000;

const STREAM_REWIND_MS = 800;
const BARGE_HOLD_MS = 90;
const BARGE_BAND_RATIO = 0.45;
const BARGE_BP_HP_HZ = 300;
const BARGE_BP_LP_HZ = 3000;
const STREAM_MAX_BUFFERED = 512 * 1024;
const RECORD_MAX_MS = 6000;   
const MIN_SPEECH_MS = 300;    
const ECHO_TAIL_MS = 400;
const GAIN = 40;

const FALLBACK_LEVEL_RATIO = 1.6;
const FALLBACK_HOLD_MS = 260;

const FALLBACK_VOICEBAND_MIN = 0.05;

const SPECTRAL_VOICE_MIN = 0.30;

const NOISE_LEARN_MIN_MS = 400;

const MIC_ECHO_CANCELLATION = false;

const RING_MS = 1000;
const BACKTRACK_MS = 360;
const F0_WIN_MS = 320;
const F0_MIN_INTERVAL_MS = 60;
const IDLE_PROBE_MS = 250;

const GATE_MARGIN = 0.010;
const LO_ABS = 0.026;         
const NOISE_FLOOR_MIN = 0.004; 
const NOISE_FLOOR_MAX = 0.050; 
const END_MS = 420;

const F0_CLARITY_MIN = 0.30;
const F0_LOCKOUT_MS = 200;

const VOICE_F0_MIN_HZ = 75;
const VOICE_F0_MAX_HZ = 165;
const BARGE_F0_MAX_HZ = 165;

const FEMALE_F0_MIN_HZ = 165;
const MALE_F0_MIN_HZ = 75;

const PITCH_GATE_CLARITY_MIN = 0.35;
const PITCH_GATE_SILENCE_RMS = 0.012;
const PITCH_GATE_MIN_INTERVAL_MS = 60;
const BARGE_CONFIRM = 2;

const BARGE_LEVEL_RATIO = 2.2;

const BARGE_F0_MIN_HZ = FEMALE_F0_MIN_HZ;

const BARGE_GUARD_MS = 420;


const BARGE_COOLDOWN_MS = 900;

const ACOUSTIC_MUTE_MS = 2800;
const ACOUSTIC_MUTE_MAX_MS = 9000;

const CONNECT_TIMEOUT_MS = 2500;

const MERGE_MAX_LEN = 300;         
const MERGE_HOLD_MS = 5000;


const DIAG_FILE = path.join(__dirname, '..', 'logs', 'asr_diag.log');
function _diagPath() {
    try { fs.mkdirSync(path.join(__dirname, '..', 'logs'), { recursive: true }); } catch (e) {   }
    return DIAG_FILE;
}

const diag = {
    file: null,
    t0: Date.now(),
    write(kind, msg) {
        try {
            if (!this.file) this.file = _diagPath();
            const s = ((Date.now() - this.t0) / 1000).toFixed(1);
            fs.appendFileSync(this.file, `[${s}s] ${kind} ${msg}\n`);
        } catch (e) {   }
    },
    clear() {
        try {
            if (!this.file) this.file = _diagPath();
            fs.writeFileSync(this.file, '');
        } catch (e) {   }
    }
};

function resample(data, ratio, outLen) {
    if (!data || !data.length) return new Float32Array(0);
    const n = outLen || Math.max(1, Math.round(data.length / ratio));
    if (Math.abs(ratio - 1) < 0.01) return new Float32Array(data);
    const out = new Float32Array(n);
    const step = data.length / n;
    for (let i = 0; i < n; i++) {
        const pos = i * step;
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, data.length - 1);
        const f = pos - i0;
        out[i] = data[i0] * (1 - f) + data[i1] * f;
    }
    return out;
}

function toPcm16Le(f32) {
    const n = f32.length;
    const buf = new ArrayBuffer(n * 2);
    const view = new DataView(buf);
    for (let i = 0; i < n; i++) {
        let v = f32[i];
        v = v > 1 ? 1 : (v < -1 ? -1 : v);
        
        view.setInt16(i * 2, v * 32767, true);
    }
    return new Uint8Array(buf);
}

function rmsOf(buf, from, to) {
    const a = from || 0;
    const b = to === undefined ? buf.length : to;
    if (b - a < 64) return 0;
    let s = 0;
    for (let i = a; i < b; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / (b - a));
}

function isNoise(text) {
    if (!text) return true;
    const t = text.trim().toLowerCase();
    if (/[一-鿿]/.test(t)) return t.replace(/[^一-鿿]/g, '').length < 1;
    if (t.length < 3) return true;
    const fillers = ['the', 'a', 'an', 'of', 'to', 'and', 'you', 'your', 'what', 'where', 'is', 'it'];
    const words = t.split(/[^a-z]+/).filter(Boolean);
    if (words.length && words.every(w => fillers.includes(w))) return true;
    return false;
}

const F0_MIN_HZ = 60;
const F0_MAX_HZ = 320;
const YIN_THRESHOLD = 0.45;

const YIN_ABS_RATIO = 0.25;
const YIN_MAX_DP = 0.60;

function estimateF0(buf, from, to, sampleRate) {
    const n = to - from;
    if (n < 512) return { hz: -1, clarity: 0 };

    let mean = 0;
    for (let i = from; i < to; i++) mean += buf[i];
    mean /= n;

    const minLag = Math.max(2, Math.floor(sampleRate / F0_MAX_HZ));
    const maxLag = Math.min(n - 2, Math.ceil(sampleRate / F0_MIN_HZ));
    if (maxLag <= minLag) return { hz: -1, clarity: 0 };

    let r0 = 0;
    for (let i = from; i < to; i++) {
        const v = buf[i] - mean;
        r0 += v * v;
    }
    r0 /= n;
    if (r0 < 1e-12) return { hz: -1, clarity: 0 };

    const d = new Float32Array(maxLag + 1);
    for (let lag = minLag; lag <= maxLag; lag++) {
        let sum = 0;
        const lim = n - lag;
        for (let i = 0; i < lim; i++) {
            sum += (buf[from + i] - mean) * (buf[from + i + lag] - mean);
        }
        const r = sum / lim;
        d[lag] = 2 * r0 - 2 * r;
    }

    const dp = new Float32Array(maxLag + 1);
    let cum = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
        cum += d[lag];
        dp[lag] = cum > 0 ? (d[lag] * lag) / cum : 1;
    }

    let tauMin = -1, dpMin = Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
        if (dp[lag] < dpMin) { dpMin = dp[lag]; tauMin = lag; }
    }
    const absThresh = Math.max(dpMin * YIN_ABS_RATIO, YIN_THRESHOLD);
    let tau = -1;
    if (tauMin >= 0) {
        for (let lag = minLag + 1; lag <= tauMin; lag++) {
            if (dp[lag] < absThresh) {
                while (lag + 1 <= tauMin && dp[lag + 1] < dp[lag]) lag++;
                tau = lag;
                break;
            }
        }
        if (tau < 0) tau = tauMin;
    }
    if (tau < 0 || dpMin > YIN_MAX_DP) {
        let best = (tauMin >= 0) ? tauMin : minLag;
        const cl = Math.max(0, Math.min(1, 1 - dpMin));
        const candHz = sampleRate / best;
        return {
            hz: (candHz >= F0_MIN_HZ && candHz <= F0_MAX_HZ) ? candHz : -1,
            clarity: cl,
            dip: best,
            minDp: dpMin,
            fallback: true,
        };
    }

    let refined = tau;
    if (tau > minLag && tau < maxLag) {
        const y0 = dp[tau - 1], y1 = dp[tau], y2 = dp[tau + 1];
        const denom = (y0 - 2 * y1 + y2);
        if (Math.abs(denom) > 1e-12) {
            const delta = 0.5 * (y0 - y2) / denom;
            if (Math.abs(delta) <= 1) refined = tau + delta;
        }
    }
    const hz = sampleRate / refined;
    const clarity = Math.max(0, Math.min(1, 1 - dpMin));
    return {
        hz: (hz >= F0_MIN_HZ && hz <= F0_MAX_HZ) ? hz : -1,
        clarity,
        dip: tau,
        minDp: dpMin,
        absThresh,
        fallback: false,
    };
}

class ASRProcessor {
    constructor(vadUrl, asrUrl, config = null) {
        this.vadUrl = vadUrl;     
        this.asrUrl = asrUrl;     

        this.streamWsUrl = (config && config.asr && config.asr.stream_url) || null;

        const _asrCfg = (config && config.asr) || {};
        this._uttHoldMs = Math.max(0, Number(_asrCfg.utterance_hold_ms ?? 1200) || 0);
        this._uttMaxWaitMs = Math.max(this._uttHoldMs,
            Number(_asrCfg.utterance_max_wait_ms ?? 3500) || 0);
        this._uttPending = null;
        this._uttTimer = null;
        this._crossHoldMs = Math.max(0,
            Number(_asrCfg.utterance_cross_hold_ms ?? 0) || 0);
        this._crossPending = null;
        this._crossTimer = null;

        this.isTtsPlaying = null;
        this.isSheReplying = null;

        if (!this.streamWsUrl && asrUrl) {
            try {
                const u = new URL(asrUrl);
                this.streamWsUrl = `ws://${u.host}/v1/asr_stream`;
            } catch (e) { this.streamWsUrl = null; }
        }
        this._ws = null;
        this._wsState = 'closed';
        this._wsRetry = 0;
        this._wsRetryTimer = null;
        this._connWatchdog = null;
        this._bargeLoudSince = 0;
        this._bargeCooldownUntil = 0;
        this._bargeF0At = 0;

        this._bargeEnabled = (config && config.ui && config.ui.allow_barge_in !== undefined)
            ? !!config.ui.allow_barge_in : true;

        this.stream = null;
        this.audioContext = null;
        this.isRecording = false;
        this.isProcessingAudio = false;
        this._ttsGateMayBeStuck = false;
        this.asrLocked = false;
        this._asrQueue = [];
        this._mergeBuf = '';
        this._mergeBufRaw = '';
        this._lastVoiceEndAt = 0;
        this.micSampleRate = 48000;
        this.ratio = 3;

        this._ring = null;
        this._ringW = 0;
        this._ringFilled = 0;
        this._win = null;         
        this._winLen = 0;

        this.recordingBuf = [];
        this.suspended = false;
        this._silenceStart = 0;
        this._speakStartedAt = 0;
        this._echoBlockedUntil = 0;
        this._loudSince = 0;
        this._lastSpeakEndAt = 0;
        this._recStartedAt = 0;
        this._noiseFloor = 0.010;
        this._bargeHits = 0;
        this._bargeFired = false;
        this._bargeInSegment = false;
        this._bargeMuteUntil = 0;
        this._bargeMuteTimer = null;
        this._bargeMuteActive = false;
        this._bargeMuteStartedAt = 0;
        this._bargeMuteAt = 0;
        this.onAcousticMute = null;
        this.onAcousticUnmute = null;
        this.levelTimer = null;
        this.recordWatchdog = null;
        this._frameCount = 0;

        this.onSpeechRecognized = null;
        this.onBargeIn = null;
    }

    _ringPush(data, n) {
        const cap = this._ring.length;
        let w = this._ringW;
        for (let i = 0; i < n; i++) {
            this._ring[w] = data[i];
            w = (w + 1) % cap;
        }
        this._ringW = w;
        if (this._ringFilled < cap) {
            this._ringFilled = Math.min(cap, this._ringFilled + n);
        }
    }

    
    _ringTail(n) {
        const cap = this._ring.length;
        const m = Math.min(n, this._ringFilled);
        const out = new Float32Array(m);
        const start = (this._ringW - m + cap) % cap;
        for (let i = 0; i < m; i++) out[i] = this._ring[(start + i) % cap];
        return out;
    }

    _ringCopyInto(dst) {
        const cap = this._ring.length;
        const m = Math.min(dst.length, this._ringFilled);
        const start = (this._ringW - m + cap) % cap;
        const off = dst.length - m;
        if (off > 0) dst.fill(0, 0, off);
        for (let i = 0; i < m; i++) dst[off + i] = this._ring[(start + i) % cap];
    }

    _learnNoiseFloor(r, loGate) {
        if (this.isProcessingAudio) return;
        if (r < loGate) {
            this._noiseFloor = Math.min(NOISE_FLOOR_MAX,
                Math.max(NOISE_FLOOR_MIN, this._noiseFloor * 0.99 + r * 0.01));
        }
    }

    _logBoot(msg) {
        const line = `[${new Date().toISOString()}] ${msg}`;
        try {
            console.log(line);
            const fs = require('fs');
            const p = require('path');
            const dir = p.join(__dirname, '..', 'logs');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.appendFileSync(p.join(dir, 'mic_boot.log'), line + '\n');
        } catch (e) {   }
    }

    _noiseTemplate = null;
    _noiseBins = 0;
    _noiseLearnMs = 0;          
    _noiseFrozen = false;       

    _hann(size) {
        this._hannCache = this._hannCache || new Map();
        let w = this._hannCache.get(size);
        if (w) return w;
        w = new Float32Array(size);
        for (let i = 0; i < size; i++) {
            w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
        }
        this._hannCache.set(size, w);
        return w;
    }

    _spectrum(buf, from, to) {
        const n = to - from;
        let size = 512;
        while (size * 2 <= n && size < 4096) size *= 2;
        const half = size >> 1;
        const re = new Float32Array(size);
        const im = new Float32Array(size);
        const hann = this._hann(size);
        for (let i = 0; i < size; i++) {
            const k = from + i;
            re[i] = (k < to ? (buf[k] || 0) : 0) * hann[i];
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
        for (let i = 0; i < half; i++) {
            mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
        }
        return { size, half, mag, re, im, hzPerBin: (this.micSampleRate || 48000) / size };
    }

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
        const a = 0.12;
        const t = this._noiseTemplate;
        for (let i = 0; i < bins; i++) {
            t[i] = t[i] * (1 - a) + sp.mag[i] * a;
        }
        this._noiseLearnMs += (to - from) / (this.micSampleRate || 48000) * 1000;
    }

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
        const snrDb = 10 * Math.log10(Math.max(ratio, 1e-9));
        return { ratio, snrDb, learned: true };
    }

    _voiceBandRatio(buf, from, to) {
        const n = to - from;
        if (n < 256) return 0;
        let size = 512;
        while (size * 2 <= n && size < 4096) size *= 2;
        const half = size >> 1;

        const w = new Float32Array(size);
        const hann = this._hann(size);
        for (let i = 0; i < size; i++) {
            const k = from + i;
            w[i] = (k < to ? (buf[k] || 0) : 0) * hann[i];
        }

        const re = new Float32Array(size);
        const im = new Float32Array(size);
        re.set(w);
        for (let i = 1, j = 0; i < size; i++) {
            let bit = size >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                let t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
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

        const sr = this.micSampleRate || 48000;
        const hzPerBin = sr / size;
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

    async setup() {
        diag.clear();
        this._logBoot('setup() 被调用，开始申请麦克风...');
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: MIC_ECHO_CANCELLATION,
                noiseSuppression: false,
                autoGainControl: false
            }
        });

        const track = this.stream.getAudioTracks()[0];
        const st = track.getSettings ? track.getSettings() : {};
        this.micSampleRate = st.sampleRate || 48000;
        this.ratio = this.micSampleRate / TARGET_SR;
        diag.write('MIC', `采样率=${this.micSampleRate} 比例=${this.ratio.toFixed(2)}`);

        const ringLen = Math.ceil(this.micSampleRate * RING_MS / 1000);
        this._ring = new Float32Array(ringLen);
        this._ringW = 0;
        this._ringFilled = 0;
        this._winLen = Math.floor(this.micSampleRate * F0_WIN_MS / 1000);
        this._win = new Float32Array(this._winLen);
        diag.write('FAN', `风扇判别: 谱减阈值=${(SPECTRAL_VOICE_MIN * 100).toFixed(0)}% `
            + `模板最少学习=${NOISE_LEARN_MIN_MS}ms 频谱分辨率=`
            + `${(48000 / 4096).toFixed(1)}Hz/bin(判定80~4000Hz)`);
        diag.write('FAN', '噪声模板初始为未学习状态'
            + `（前 ${NOISE_LEARN_MIN_MS}ms 一律放行，避免模板不准时漏掉第一句话）`);
        diag.write('MIC', `环形缓冲=${(RING_MS / 1000).toFixed(2)}s(${ringLen}) 判定窗=${F0_WIN_MS}ms(${this._winLen})`);

        const _minLag = Math.max(2, Math.floor(this.micSampleRate / F0_MAX_HZ));
        const _maxLag = Math.min(this._winLen - 2, Math.ceil(this.micSampleRate / F0_MIN_HZ));
        const _ptsPerPeriod = this._winLen / Math.max(1, _maxLag);
        diag.write('MIC', `YIN窗口点数=${this._winLen} lag范围=${_minLag}..${_maxLag} `
            + `每周期采样点=${_ptsPerPeriod.toFixed(1)}（要 >=20 才稳）`
            + ` 阈值=${YIN_THRESHOLD}`);
        if (_ptsPerPeriod < 20) {
            diag.write('MIC', '⚠️ 每周期采样点不足，YIN 很可能测不出基频——'
                + '考虑调大 F0_WIN_MS 或降低 F0_MIN_HZ');
        }

        this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: this.micSampleRate
        });
        if (this.audioContext.state === 'suspended') {
            try { await this.audioContext.resume(); } catch (e) {   }
        }
        diag.write('MIC', `AudioContext=${this.audioContext.state}`);

        const source = this.audioContext.createMediaStreamSource(this.stream);
        const node = this.audioContext.createScriptProcessor(1024, 1, 1);
        this._node = node;

        this.connectStream();

        node.onaudioprocess = (e) => {
            const data = e.inputBuffer.getChannelData(0);

            if (this.audioContext.state === 'suspended') {
                this.audioContext.resume().catch(() => {   });
            }
            if (!this._ring) return;

            const n = data.length;
            let _sum = 0;
            for (let i = 0; i < n; i++) { const _v = data[i]; _sum += _v * _v; }
            const _inRms = Math.sqrt(_sum / Math.max(1, n));
            const _NOISE_GATE = 0.0012;
            let _g = (_inRms < _NOISE_GATE)
                ? 1
                : (0.22 / Math.max(_inRms, _NOISE_GATE));
            _g = Math.min(Math.max(_g, 1), GAIN);
            
            this._gainSm = this._gainSm ? (0.6 * this._gainSm + 0.4 * _g) : _g;
            const _gain = this._gainSm;
            for (let i = 0; i < n; i++) {
                const v = data[i] * _gain;
                data[i] = (v > 0.8 || v < -0.8) ? Math.tanh(v) : v;
            }

            this._ringPush(data, n);

            if (this._streamOnline()) {
                const outLen = Math.round(n / this.ratio);
                const f32 = resample(data, this.ratio, outLen);
                this._streamSendAudio(toPcm16Le(f32));
            }

            
            if (this.isRecording) {
                for (let i = 0; i < n; i++) this.recordingBuf.push(data[i]);
            }

            this._frameCount++;

            const winLen = this._winLen;
            if (this._ringFilled < winLen) return;
            this._ringCopyInto(this._win);
            const r = rmsOf(this._win, 0, winLen);

            if (this.suspended) {
                if (r > Math.max(LO_ABS, this._noiseFloor + GATE_MARGIN)) {
                    const sp = this._spectralSubtractRatio(this._win, 0, winLen);
                    const _gate = Math.max(LO_ABS, this._noiseFloor + GATE_MARGIN);
                    const _loudEnough = r > Math.max(_gate * 1.8, this._noiseFloor + 0.016);
                    if (!sp.learned || sp.ratio >= SPECTRAL_VOICE_MIN || _loudEnough) {
                        this.resumeMic();
                        diag.write('MIC', `挂起期间检测到人声 `
                            + `RMS=${r.toFixed(4)} 谱减后剩=${(sp.ratio * 100).toFixed(1)}% `
                            + `底噪=${this._noiseFloor.toFixed(4)} `
                            + `(${sp.ratio >= SPECTRAL_VOICE_MIN ? '谱减判据' : (_loudEnough ? '能量兜底' : '未学噪声模板')})`
                            + ` → 已恢复`);
                    }
                    
                }
                return;
            }

            const hiGate = Math.max(LO_ABS, this._noiseFloor + GATE_MARGIN);
            const loGate = Math.max(LO_ABS, this._noiseFloor + GATE_MARGIN * 0.45);

            if (!this.isRecording) {
                const now = Date.now();

                const loud = r > hiGate;

                const _spec = this._spectralSubtractRatio(this._win, 0, winLen);
                const _specOk = !_spec.learned || _spec.ratio >= SPECTRAL_VOICE_MIN;

                if (!this.isProcessingAudio && !this.isRecording && loud
                    && r > hiGate * FALLBACK_LEVEL_RATIO && _specOk) {
                    if (!this._loudSince) this._loudSince = now;
                    const holdMs = now - this._loudSince;
                    if (holdMs >= FALLBACK_HOLD_MS && now >= this._echoBlockedUntil) {
                        if (this._streamOnline()) {
                            
                        } else {
                            diag.write('F0', `基频未命中但电平持续偏高（${holdMs}ms, `
                                + `RMS=${r.toFixed(4)} > ${(hiGate * FALLBACK_LEVEL_RATIO).toFixed(4)}）`
                                + `谱减后剩 ${(_spec.ratio * 100).toFixed(1)}%`
                                + (_spec.learned
                                    ? `>=${(SPECTRAL_VOICE_MIN * 100).toFixed(0)}%`
                                    : '（模板未学稳，放行）')
                                + ' → 电平兜底开录');
                            this._loudSince = 0;
                            this.startRecording();
                        }
                        return;
                    }
                } else if (loud && !_specOk) {
                    
                    const _gate2 = Math.max(LO_ABS, this._noiseFloor + GATE_MARGIN);
                    const _loud2 = r > Math.max(_gate2 * 1.6, this._noiseFloor + 0.014);
                    if (_loud2 && !this._streamOnline() && now >= this._echoBlockedUntil) {
                        diag.write('SPEC', `谱减挡下但电平明显偏高 RMS=${r.toFixed(4)} `
                            + `> ${(Math.max(_gate2 * 1.6, this._noiseFloor + 0.014)).toFixed(4)}`
                            + ` → 电平兜底开录`);
                        this._loudSince = 0;
                        this.startRecording();
                        return;
                    }
                    if (!this._specLogAt || now - this._specLogAt > 1500) {
                        this._specLogAt = now;
                        diag.write('SPEC', `谱减挡下疑似风扇：`
                            + `RMS=${r.toFixed(4)} 但减掉噪声模板后只剩 `
                            + `${(_spec.ratio * 100).toFixed(1)}% < ${(SPECTRAL_VOICE_MIN * 100).toFixed(0)}%`
                            + `（已学${(this._noiseLearnMs / 1000).toFixed(1)}s）→ 不开录`);
                    }
                    this._loudSince = 0;
                } else {
                    this._loudSince = 0;
                }

                if (!loud) {
                    this._learnNoise(this._win, 0, winLen);
                } else if (!_specOk) {
                    const _learnHi = Math.max(hiGate * 1.25, this._noiseFloor * 1.6 + 0.008);
                    if (r <= _learnHi) {
                        this._learnNoise(this._win, 0, winLen);
                    }
                }
                this._learnNoiseFloor(r, loGate);

                if (this.isProcessingAudio) {
                    this._handleBarge(r, now);
                    return;
                }

                if (now < this._echoBlockedUntil) return;

                if (this._streamOnline()) return;

            } else {
                if (r < loGate) {
                    if (!this._silenceStart) this._silenceStart = Date.now();
                    if (Date.now() - this._silenceStart >= END_MS) {
                        const spoken = this.recordingBuf.length / this.micSampleRate * 1000;
                        if (spoken >= MIN_SPEECH_MS) {
                            this.finishRecording().catch((e) => this._onSubmitError(e));
                        } else {
                            this._silenceStart = 0;
                        }
                    }
                } else {
                    this._silenceStart = 0;
                }
            }
        };

        source.connect(node);
        node.connect(this.audioContext.destination);

        this.levelTimer = setInterval(() => {
            if (!this._ring || !this._win) return;
            this._ringCopyInto(this._win);
            const r = rmsOf(this._win, 0, this._winLen);
            const lv = r < 0.005 ? '静音' : r < 0.02 ? '偏低' : r < 0.2 ? '正常' : '偏大';
            diag.write('LVL',
                `RMS=${r.toFixed(4)}(${lv}) 噪声基底=${this._noiseFloor.toFixed(4)} ` +
                `触发门限=${Math.max(LO_ABS, this._noiseFloor + GATE_MARGIN).toFixed(4)} ` +
                `录音=${this.isRecording} 缓冲=${(this.recordingBuf.length / this.micSampleRate).toFixed(2)}s ` +
                `环=${(this._ringFilled / this.micSampleRate).toFixed(2)}s ` +
                `她说=${this.isProcessingAudio} 打断=${this._bargeFired} 帧=${this._frameCount}`);
        }, 2000);

        this._logBoot(`麦克风就绪:采样率=${this.micSampleRate} `
            + `判定窗=${this._winLen}点 环=${RING_MS}ms `
            + `AEC=${MIC_ECHO_CANCELLATION} 打断保持=${BARGE_HOLD_MS}ms 帧计数=${this._frameCount}`);

        } catch (err) {
            this._logBoot(`麦克风启动失败:${err && err.name} ${err && err.message}`);
            diag.write('MIC', `启动失败: ${err && err.message}`);
            this.stream = null;
        }
    }

    _bandRms(win, n) {
        const fs = this.micSampleRate;
        const aHP = 1 / (1 + 2 * Math.PI * BARGE_BP_HP_HZ / fs);
        const aLP = (2 * Math.PI * BARGE_BP_LP_HZ / fs) / (1 + 2 * Math.PI * BARGE_BP_LP_HZ / fs);
        let x1 = 0, y1 = 0, y2 = 0, sum = 0;
        for (let i = 0; i < n; i++) {
            const x = win[i];
            const hp = aHP * (y1 + x - x1); x1 = x; y1 = hp;
            const lp = y2 + aLP * (hp - y2); y2 = lp;
            sum += lp * lp;
        }
        return Math.sqrt(sum / n);
    }

    _handleBarge(r, now) {
        if (this._bargeMuteUntil) {
            if (now < this._bargeMuteUntil) {
                const _mHiGate = Math.max(LO_ABS, this._noiseFloor + GATE_MARGIN);
                if (r > _mHiGate * 1.5) {
                    const _elapsed = now - (this._bargeMuteStartedAt || now);
                    if (_elapsed < ACOUSTIC_MUTE_MAX_MS) {
                        this._bargeMuteUntil = now + ACOUSTIC_MUTE_MS;
                        this._bargeMuteAt = now;
                        this._armBargeMuteWatchdog();
                    }
                }
            } else {
                const _mHiGate2 = Math.max(LO_ABS, this._noiseFloor + GATE_MARGIN);
                if (r > _mHiGate2 * 1.5) {
                    const _elapsed2 = now - (this._bargeMuteStartedAt || now);
                    if (_elapsed2 < ACOUSTIC_MUTE_MAX_MS) {
                        this._bargeMuteUntil = now + ACOUSTIC_MUTE_MS;
                        this._bargeMuteAt = now;
                        this._armBargeMuteWatchdog();
                        diag.write('BARGE', '窗口到期但电平仍高（你还在说话）→ 续期静音，等文本确认');
                    } else {
                        this.clearBargeMute('静音封顶 9s 仍无文本 → 强制恢复（防永久哑掉）');
                    }
                } else {
                    this.clearBargeMute('看门狗超时（无文本确认且电平已回落，判为误触发）');
                }
            }
        }

        if (!this._bargeEnabled || this._bargeFired) return;

        const _speakFrom = this._speakStartedAt || 0;
        if (_speakFrom && (now - _speakFrom) < BARGE_GUARD_MS) {
            this._bargeLoudSince = 0;
            return;
        }
        if (this._bargeCooldownUntil && now < this._bargeCooldownUntil) {
            this._bargeLoudSince = 0;
            return;
        }

        const hiGate = Math.max(LO_ABS, this._noiseFloor + GATE_MARGIN);
        const thresh = hiGate * BARGE_LEVEL_RATIO;
        if (r <= thresh) {
            this._bargeLoudSince = 0;
            return;
        }

        if (now - (this._bargeF0At || 0) < PITCH_GATE_MIN_INTERVAL_MS) return;
        this._bargeF0At = now;

        const f0 = estimateF0(this._win, 0, this._winLen, this.micSampleRate);
        const _hz = f0 && f0.hz > 0 ? f0.hz : -1;
        const _cl = f0 ? f0.clarity : 0;

        if (_hz < 0 || _cl < F0_CLARITY_MIN) {
            this._bargeLoudSince = 0;
            return;
        }
        if (_hz >= BARGE_F0_MIN_HZ) {
            this._bargeLoudSince = 0;
            return;
        }
        if (_hz < MALE_F0_MIN_HZ) {
            this._bargeLoudSince = 0;
            return;
        }

        if (!this._bargeLoudSince) this._bargeLoudSince = now;
        if (now - this._bargeLoudSince >= BARGE_HOLD_MS) {
            diag.write('BARGE', `音调判为男声 F0=${_hz.toFixed(0)}Hz `
                + `(男声带 ${MALE_F0_MIN_HZ}~${BARGE_F0_MIN_HZ}Hz) `
                + `clarity=${_cl.toFixed(2)} RMS=${r.toFixed(4)}>${thresh.toFixed(4)} `
                + `持续${now - this._bargeLoudSince}ms → 判定你在打断`);
            this._fireBargeIn();
        }
    }

    _armBargeMuteWatchdog() {
        if (this._bargeMuteTimer) { clearTimeout(this._bargeMuteTimer); this._bargeMuteTimer = null; }
        const remain = Math.max(200, (this._bargeMuteUntil || 0) - Date.now()) + 300;
        this._bargeMuteTimer = setTimeout(() => {
            this._bargeMuteTimer = null;
            if (this._bargeMuteUntil && Date.now() >= this._bargeMuteUntil) {
                this.clearBargeMute('看门狗到期（无文本确认，判为误触发）');
            } else if (this._bargeMuteUntil) {
                this._armBargeMuteWatchdog();
            }
        }, remain);
    }

    _fireBargeIn() {
        this._bargeHits = 0;
        this._bargeLoudSince = 0;
        if (this._bargeFired) return;   
        this._bargeFired = true;
        this._bargeCooldownUntil = Date.now() + BARGE_COOLDOWN_MS;
        this._streamSend({ interrupt: true, hint: 'acoustic' });
        if (this.onBargeIn) {
            try { this.onBargeIn(); } catch (e) { diag.write('BARGE', 'onBargeIn 回调异常 ' + e.message); }
        }
    }

    clearBargeMute(why) {
        const was = this._bargeMuteUntil;
        this._bargeMuteUntil = 0;
        this._bargeMuteAt = 0;
        this._bargeMuteStartedAt = 0;
        if (this._bargeMuteTimer) {
            clearTimeout(this._bargeMuteTimer);
            this._bargeMuteTimer = null;
        }
        if (this._bargeMuteActive) {
            this._bargeMuteActive = false;
            if (this.onAcousticUnmute) {
                try { this.onAcousticUnmute(); } catch (e) {   }
            }
        }
        if (was) diag.write('BARGE', `解除声学静音（${why || '未说明'}）`);
    }

    startRecording() {
        if (this.isRecording) return;

        if (this._streamOnline()) return;
        if (this.isProcessingAudio) return;

        this.isRecording = true;
        this._silenceStart = 0;
        this._loudSince = 0;
        try {
            const base = String(this.asrUrl || '').replace(/\/v\d+\/[^/]*$/, '');
            if (base) fetch(base + '/warmup').catch(() => {});
        } catch (_) {   }
        this._noiseFrozen = true;

        const pre = Math.floor(this.micSampleRate * (F0_WIN_MS + BACKTRACK_MS) / 1000);
        const head = this._ringTail(pre);
        this.recordingBuf = [];
        for (let i = 0; i < head.length; i++) this.recordingBuf.push(head[i]);

        this._recStartedAt = Date.now();
        diag.write('REC', `开始录音 回溯=${(head.length / this.micSampleRate * 1000).toFixed(0)}ms `
            + `噪声基底=${this._noiseFloor.toFixed(4)} 打断=${this._bargeInSegment}`);
        if (!this.recordWatchdog) {
            this.recordWatchdog = setTimeout(() => {
                diag.write('REC', `看门狗 ${RECORD_MAX_MS / 1000}s 强制提交`);
                if (this.isRecording) this.finishRecording(true).catch((e) => this._onSubmitError(e));
            }, RECORD_MAX_MS);
        }
    }

    _onSubmitError(e) {
        try {
            diag.write('REC', '★ 提交流程异常: ' + (e && (e.stack || e.message || String(e))));
            console.error('[ASR] 提交流程异常:', e);
        } catch (_) {   }
    }

    async finishRecording(force = false) {
        let slice, recStart, recEnd, isBarge;
        try {
        if (this.recordWatchdog) { clearTimeout(this.recordWatchdog); this.recordWatchdog = null; }
        if (!this.isRecording && !force) return;
        this.isRecording = false;
        this._silenceStart = 0;
        this._noiseFrozen = true;

        
        isBarge = this._bargeInSegment;
        this._bargeInSegment = false;

        slice = this.recordingBuf;
        this.recordingBuf = [];
        if (!slice.length) {
            diag.write('REC', '空片段，丢弃');
            return;
        }

        if (slice.length > this._winLen) {
            const mid = Math.floor(slice.length / 2);
            let worst = 1;
            for (const off of [-this._winLen, 0, this._winLen]) {
                const from = mid + off;
                if (from < 0 || from + this._winLen > slice.length) continue;
                const r = this._spectralSubtractRatio(slice, from, from + this._winLen);
                if (!r.learned) { worst = 1; break; }   
                if (r.ratio > worst) worst = r.ratio;
            }
            if (worst < SPECTRAL_VOICE_MIN) {
                diag.write('REC', `谱减后仅剩 ${(worst * 100).toFixed(1)}%`
                    + ` < ${(SPECTRAL_VOICE_MIN * 100).toFixed(0)}%，`
                    + `判定为持续噪声（风扇/电流），不送识别`);
                return;
            }
            diag.write('REC', `谱减后剩 ${(worst * 100).toFixed(1)}%`
                + ` >= ${(SPECTRAL_VOICE_MIN * 100).toFixed(0)}%，送去识别`);
        }

        recStart = this._recStartedAt;
        recEnd = Date.now();
        this._recStartedAt = 0;
        this._lastVoiceEndAt = recEnd;

        const secs = slice.length / this.micSampleRate;
        const level = rmsOf(slice, 0);
        diag.write('REC', `提交 ${secs.toFixed(2)}s 电平=${level.toFixed(4)} 打断段=${isBarge}`);

        if (slice.length < this.micSampleRate * 0.25 || level < 0.0015) {
            diag.write('REC', '全静音，跳过');
            return;
        }

        if (this.asrLocked) {
            if (this._asrQueue.length >= 3) {
                this._asrQueue.shift();
                diag.write('REC', '识别队列已满，挤掉最旧的一条');
            }
            this._asrQueue.push({ slice, recStart, recEnd, isBarge });
            diag.write('REC', `识别中，入队等待（队列=${this._asrQueue.length}）`);
            return;
        }
        } finally {
            this._noiseFrozen = false;
        }
        await this._recognize(slice, recStart, recEnd, isBarge);
    }

    _isEchoSegment(recStart, recEnd, isBarge) {
        if (isBarge) return false;
        if (this.isProcessingAudio && (Date.now() - recEnd) < 3000) return true;
        const s = this._lastSpeakEndAt || 0;
        if (recStart && s && recStart < s) return true;
        return false;
    }

    async _recognize(slice, recStart, recEnd, isBarge) {
        diag.write('ASR', `▶ 进入识别 ${(slice.length / this.micSampleRate).toFixed(2)}s → ${this.asrUrl}`);
        const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const toTimer = ac ? setTimeout(() => { try { ac.abort(); } catch (_) {} }, 45000) : null;
        try {
            this.asrLocked = true;
            const pcm16 = resample(slice, this.ratio, Math.round(slice.length / this.ratio));
            const blob = this.toWav(pcm16);

            const fd = new FormData();
            fd.append('file', blob, 'rec.wav');
            diag.write('ASR', `▶ WAV 就绪 ${blob.size}B，请求已发出`);
            const resp = await fetch(this.asrUrl,
                ac ? { method: 'POST', body: fd, signal: ac.signal } : { method: 'POST', body: fd });
            diag.write('ASR', `▶ 收到响应 HTTP ${resp.status}`);
            const r = await resp.json();
            diag.write('ASR', `status=${r.status} text="${r.text || ''}"`);

            if (this._isEchoSegment(recStart, recEnd, isBarge)) {
                diag.write('ASR', `回声拦截：这段录音期间她在说话 → 丢弃 "${(r.text || '').slice(0, 30)}"`);
                return;
            }

            if (r.status === 'success' && r.text) {
                if (isNoise(r.text)) {
                    diag.write('ASR', `识别结果疑似噪声(${r.text.slice(0, 30)})，丢弃 → 不触发回答`);
                } else {
                    this._pushToMergeBuffer(r.text, r.raw);
                }
            } else {
                diag.write('ASR', `无文本 → 当作噪声，不触发 (status=${r.status} message=${r.message || '无'} raw=${r.raw !== undefined ? '有' : '无'})`);
            }
        } catch (e) {
            const aborted = !!(ac && ac.signal && ac.signal.aborted);
            const msg = aborted ? '请求超时(45s 无响应) —— 后端没在跑或卡死了'
                                : (e && (e.message || String(e)));
            diag.write('ASR', (aborted ? '⏱ ' : '✗ ') + '请求失败 ' + msg);
            console.error('[ASR] 识别请求失败:', msg);
            this._notifyAsrError(aborted ? "I can't reach my ears right now (backend silent for 45s)."
                                         : "I can't reach my ears right now (" + msg + ").");
        } finally {
            if (toTimer) clearTimeout(toTimer);
            this.asrLocked = false;
            if (this._asrQueue.length > 0) {
                const next = this._asrQueue.shift();
                diag.write('ASR', `继续处理队列中下一段（剩余=${this._asrQueue.length}）`);
                
                setTimeout(() => {
                    if (this.asrLocked) {
                        this._asrQueue.unshift(next);
                        diag.write('ASR', '已有新段在识别，排队段放回队首');
                        return;
                    }
                    this._recognize(next.slice, next.recStart, next.recEnd, next.isBarge);
                }, 120);
            }
        }
    }

    _notifyAsrError(msg) {
        const now = Date.now();
        if (now - (this._lastAsrErrorAt || 0) < 30000) return;
        this._lastAsrErrorAt = now;
        try { this.onAsrError && this.onAsrError(msg); } catch (_) {   }
    }

    async _pushToMergeBuffer(text, raw) {
        const t = String(text || '').trim();
        if (!t) return;
        const r = String(raw || '').trim();

        if (this._mergeBuf) {
            this._mergeBuf = this._joinText(this._mergeBuf, t);
            if (r) this._mergeBufRaw = this._joinText(this._mergeBufRaw || '', r);
            diag.write('MERGE', `收到补充 → 累积为: "${this._mergeBuf}"`);
            if (this._mergeBuf.length >= MERGE_MAX_LEN) {
                this._flushMergeBuffer();
                return;
            }
            if (this._looksIncomplete(this._mergeBuf)) {
                if (this._mergeTimer) clearTimeout(this._mergeTimer);
                this._mergeTimer = setTimeout(() => this._flushMergeBuffer(), MERGE_HOLD_MS);
            } else {
                this._flushMergeBuffer();
            }
            return;
        }

        this._mergeBuf = t;
        this._mergeBufRaw = r;
        diag.write('MERGE', `收到语句: "${t}"`);
        if (this._looksIncomplete(t)) {
            if (this._mergeTimer) clearTimeout(this._mergeTimer);
            this._mergeTimer = setTimeout(() => this._flushMergeBuffer(), MERGE_HOLD_MS);
            diag.write('MERGE', `疑似未说完 → 等待补充 ${MERGE_HOLD_MS}ms`);
        } else {
            this._flushMergeBuffer();
        }
    }

    _looksIncomplete(t) {
        const s = String(t || '').trim();
        if (!s) return false;
        if (/^(好的?|好吧|行|可以|对|是的|知道了|收到|没问题|没了|就这些|算了|谢谢|thanks|ok|okay|yes|yep|sure|done|got it)[.。!！~～]*$/i.test(s)) {
            return false;
        }
        if (/[。！？!?…]+$/.test(s)) return false;
        if (/[a-zA-Z0-9]\.$/.test(s)
            && !/\b(?:mr|mrs|dr|vs|etc|approx)\.$/i.test(s)) return false;
        if (/(?:然后|但是|但|还有|和|跟|或者|而|且|以及|因为|所以|如果|那个|嗯|就是|呃|呃|and|but|or|because|so|then|which|that|the|a|an|to|of)$/i.test(s)) {
            return true;
        }
        if (s.length >= 14) return false;
        return true;
    }

    _isDefinitiveClose(t) {
        const s = String(t || '').trim();
        if (!s) return false;
        return /^(?:好的?|好吧|行|可以|对|是的|知道了|收到|没问题|没了|就这些|算了|谢谢|不要了|不用了|再见|拜拜|thanks|ok|okay|yes|yep|sure|done|got it|bye|byebye)[.。!！~～?？]*$/i.test(s);
    }

    _joinText(a, b) {
        let left = a.trim();
        const right = b.trim();
        if (!left) return right;
        if (!right) return left;
        left = left.replace(/[。．.！!？?，,；;]+$/u, '');
        const sep = /[一-鿿]/.test(right.slice(0, 1)) ? '' : ' ';
        return left + sep + right;
    }

    _flushMergeBuffer() {
        if (this._mergeTimer) { clearTimeout(this._mergeTimer); this._mergeTimer = null; }
        const text = this._mergeBuf;
        const raw = this._mergeBufRaw || '';
        this._mergeBuf = '';
        this._mergeBufRaw = '';
        if (!text) return;
        const _e2e = this._lastVoiceEndAt ? Date.now() - this._lastVoiceEndAt : null;
        diag.write('MERGE',
            `提交合并结果: "${text}"（原识别: "${raw}"）`
            + (_e2e !== null ? `  |从你说完到提交 ${_e2e}ms` : ''));
        if (this.onSpeechRecognized) {
            this.onSpeechRecognized(text, raw);
        }
    }

    toWav(pcm) {
        const buf = new ArrayBuffer(44 + pcm.length * 2);
        const v = new DataView(buf);
        const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
        wstr(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true);
        wstr(8, 'WAVE'); wstr(12, 'fmt ');
        v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, TARGET_SR, true); v.setUint32(28, TARGET_SR * 2, true);
        v.setUint16(32, 2, true); v.setUint16(34, 16, true);
        wstr(36, 'data'); v.setUint32(40, pcm.length * 2, true);
        let o = 44;
        for (let i = 0; i < pcm.length; i++, o += 2) {
            const s = Math.max(-1, Math.min(1, pcm[i]));
            v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        }
        return new Blob([buf], { type: 'audio/wav' });
    }

    pauseRecording() {
        this.isProcessingAudio = true;
        this._speakStartedAt = Date.now();
        this._lastSpeakEndAt = 0;   

        this._streamSend({ tts: 1 });
        this._ttsGateMayBeStuck = true;

        this._bargeFired = false;
        this._bargeHits = 0;
        this._clearCrossPending('她开始说话');
        if (this._mergeTimer) { clearTimeout(this._mergeTimer); this._mergeTimer = null; }
        if (this._mergeBuf) {
            diag.write('MERGE', `她开始说话 → 丢弃未提交的补充缓冲: "${this._mergeBuf}"`);
            this._mergeBuf = '';
        }
        if (this._asrQueue.length) {
            diag.write('REC', `她开始说话 → 清空识别队列(${this._asrQueue.length} 条，避免混入回声)`);
            this._asrQueue = [];
        }
        if (this.isRecording) {
            if (this._bargeInSegment) {
                diag.write('REC', '她开始说话，但这是你的打断段 → 立即提交，不丢弃');
                this.finishRecording().catch((e) => this._onSubmitError(e));
            } else {
                this.isRecording = false;
                if (this.recordWatchdog) { clearTimeout(this.recordWatchdog); this.recordWatchdog = null; }
                this.recordingBuf = [];
                this._silenceStart = 0;
                diag.write('REC', '她开始说话 → 丢弃当前录音(防回声)');
            }
        }
    }

    resumeRecording() {
        this.isProcessingAudio = false;
        this._lastSpeakEndAt = Date.now();
        this._bargeFired = false;
        this._bargeHits = 0;
        this.clearBargeMute('她本轮说话结束');
        this._echoBlockedUntil = Date.now() + ECHO_TAIL_MS;
        this._streamSend({ tts: 0 });
    }

    suspendMic(pauseBackend = false) {
        this.suspended = true;
        this.clearBargeMute('麦克风挂起');
        this.recordingBuf = [];
        this.isRecording = false;
        this._bargeInSegment = false;
        if (this.recordWatchdog) { clearTimeout(this.recordWatchdog); this.recordWatchdog = null; }
        if (this._mergeTimer) { clearTimeout(this._mergeTimer); this._mergeTimer = null; }
        if (this._mergeBuf) {
            diag.write('MERGE', `麦克风挂起 → 丢弃待提交缓冲: "${this._mergeBuf}"`);
            this._mergeBuf = '';
            this._mergeBufRaw = '';
        }
        if (this._uttTimer) { clearTimeout(this._uttTimer); this._uttTimer = null; }
        this._uttPending = null;
        if (this._crossTimer) { clearTimeout(this._crossTimer); this._crossTimer = null; }
        this._crossPending = null;
        this._silenceStart = 0;
        this._asrQueue = [];
        if (pauseBackend || !this._streamOnline()) {
            this._streamSend({ paused: true });
        }
        diag.write('MIC', '挂起(停止起止判定，作废本轮语音，麦克风仍采音+仍送流)');
    }

    resumeMic() {
        this.suspended = false;
        this._silenceStart = 0;
        this._f0LockUntil = 0;   
        this._bargeHits = 0;
        this._streamSend({ paused: false });
        diag.write('MIC', '恢复监听(paused 清除，整体重置)');
    }

    
    connectStream() {
        if (this._ws && (this._ws.readyState === 0 || this._ws.readyState === 1)) return;
        const url = this.streamWsUrl;
        if (!url) { diag.write('STREAM', '未配置 ws 地址，跳过流式'); return; }
        let ws = null;
        try {
            ws = new WebSocket(url);
        } catch (e) {
            diag.write('STREAM', `创建 WS 失败: ${e}`);
            this._ws = null;
            return;
        }
        this._ws = ws;
        const _cid = (this._wsGen = (this._wsGen || 0) + 1);
        const _isCurrent = () => (this._ws === ws && this._wsGen === _cid);
        this._ws.binaryType = 'arraybuffer';
        this._ws.onopen = () => {
            if (!_isCurrent()) {
                diag.write('STREAM', `忽略旧连接的 onopen（cid=${_cid}）`);
                try { ws.close(); } catch (e) {   }
                return;
            }
            this._wsState = 'open';
            this._lastPongAt = Date.now();
            this._openedAt = Date.now();
            if (this._lastCloseAt && (this._openedAt - this._lastCloseAt) > 3000) {
                this._wsRetry = 0;
            }
            if (this._connWatchdog) { clearTimeout(this._connWatchdog); this._connWatchdog = null; }
            this._lastPongAt = Date.now();
            this._startHeartbeat();
            diag.write('STREAM', '已连接（持续录音模式：音频常送，有文本才反应）');
        };
        this._ws.onmessage = (ev) => {
            
            if (!_isCurrent()) return;
            this._onStreamMessage(ev);
        };
        this._ws.onerror = () => {
            diag.write('STREAM', '连接出错');
        };
        this._ws.onclose = () => {
            
            if (!_isCurrent()) {
                diag.write('STREAM', `忽略旧连接的 onclose（cid=${_cid}）`);
                return;
            }
            this._lastCloseAt = Date.now();
            this._stopHeartbeat();
            diag.write('STREAM', '连接关闭');
            
            this._forceReconnect('onclose');
        };
        try {
            if (this._ws.readyState === 1) this._wsState = 'open';
        } catch (e) {   }

        let _already = false;
        try { _already = (ws.readyState === 1); } catch (e) { _already = false; }
        if (this._connWatchdog) { clearTimeout(this._connWatchdog); this._connWatchdog = null; }
        if (!_already) {
            this._wsState = 'connecting';
            this._connWatchdog = setTimeout(() => {
                this._connWatchdog = null;
                if (!_isCurrent()) return;
                let rs = -1;
                try { rs = ws.readyState; } catch (e) { rs = 3; }
                if (rs === 1) return;
                diag.write('STREAM', `建连超时（readyState=${rs}），强制重连以恢复语音识别`);
                
                this._wsState = 'closed';
                this._forceReconnect('connect-timeout');
            }, CONNECT_TIMEOUT_MS);
        }
    }

    _startHeartbeat() {
        this._stopHeartbeat();
        this._lastPongAt = Date.now();
        const base = (this.streamWsUrl || '').replace(/^ws/, 'http').replace(/\/v1\/asr_stream.*$/, '');
        this._hbTimer = setInterval(() => {
            const url = (base || 'http://127.0.0.1:6006') + '/v1/health';
            let done = false;
            try {
                if (typeof fetch === 'function') {
                    fetch(url, { method: 'GET', cache: 'no-store' })
                        .then((r) => { done = true; this._lastPongAt = Date.now(); })
                        .catch(() => { done = true; });
                } else {
                    done = true;
                }
            } catch (e) { done = true; }
            const ws = this._ws;
            if (!ws || ws.readyState !== 1) {
                if (this._wsState !== 'reconnecting') {
                    diag.write('STREAM', `WS 状态=${ws ? ws.readyState : 'null'}（非 OPEN）→ 立即重连`);
                    this._forceReconnect('ws-not-open');
                }
                return;
            }
            const waited = Date.now() - (this._lastPongAt || 0);
            if (waited > 9000) {
                diag.write('STREAM', `健康探测失败 ${waited}ms（连接疑似半开）→ 立即重连`);
                this._forceReconnect('health-timeout');
            }
        }, 3000);
    }

    _forceReconnect(why) {
        if (this._wsState === 'reconnecting') return;
        this._wsState = 'reconnecting';
        const old = this._ws;
        this._ws = null;
        if (old) {
            try { old.onclose = null; old.onmessage = null; old.onerror = null; } catch (e) {   }
            try { old.close(); } catch (e) {   }
        }
        this._stopHeartbeat();
        const delay = Math.min(1500, 200 * Math.pow(2, this._wsRetry++ || 0));
        clearTimeout(this._wsRetryTimer);
        this._wsRetryTimer = setTimeout(() => this.connectStream(), delay);
        diag.write('STREAM', `重连已安排（原因=${why}，${delay}ms 后）`);
    }
    _stopHeartbeat() {
        if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
    }

    _streamSend(obj) {
        const ws = this._ws;
        if (!ws || ws.readyState !== 1) return;
        try { ws.send(JSON.stringify(obj)); } catch (e) {   }
    }

    _streamOnline() {
        const ws = this._ws;
        if (!ws) return false;
        try { return ws.readyState === 1; } catch (e) { return false; }
    }

    _streamSendAudio(pcm16) {
        const ws = this._ws;
        if (!this._streamOnline()) return;
        if (!this._deferredAudio) { this._deferredAudio = []; this._deferredAudioSize = 0; }
        const sizeOf = (b) => b.byteLength || b.length || 0;
        const CAP = 2 * 1024 * 1024;   
        
        const defer = (b) => {
            let size = this._deferredAudioSize || 0;
            while (this._deferredAudio.length && size + sizeOf(b) > CAP) {
                size -= sizeOf(this._deferredAudio.shift());
            }
            this._deferredAudio.push(b);
            this._deferredAudioSize = Math.max(0, size) + sizeOf(b);
        };
        if (ws.bufferedAmount > STREAM_MAX_BUFFERED) { defer(pcm16); return; }
        
        const backlog = this._deferredAudio.splice(0);
        this._deferredAudioSize = 0;
        let i = 0;
        for (; i < backlog.length; i++) {
            if (ws.bufferedAmount > STREAM_MAX_BUFFERED) break;
            try { ws.send(backlog[i]); } catch (e) {   }
        }
        if (i < backlog.length) {
            
            for (let j = i; j < backlog.length; j++) defer(backlog[j]);
            defer(pcm16);
            return;
        }
        try { ws.send(pcm16); } catch (e) {   }
    }

    _queueStreamUtterance(text, raw, opts) {
        const now = Date.now();
        const _ttsPlayingNowQ = !!(this.isTtsPlaying && typeof this.isTtsPlaying === 'function'
            && this.isTtsPlaying());
        const immediate = !!(opts && opts.duringTts) || !!this.isProcessingAudio || _ttsPlayingNowQ;
        if (this._crossPending) {
            const _cp = this._crossPending;
            this._crossPending = null;
            if (this._crossTimer) { clearTimeout(this._crossTimer); this._crossTimer = null; }
            if (_cp.text.trim()) {
                text = this._joinText(_cp.text, text);
                if (raw) raw = this._joinText(_cp.raw, raw); else raw = _cp.raw;
                diag.write('HOLD', `并入跨句缓冲: "${_cp.text.slice(0, 40)}" + "${text.slice(0, 40)}"`);
            }
        }
        if (!this._uttPending) {
            this._uttPending = { parts: [], raws: [], startedAt: now, duringTts: false };
        } else if (now - this._uttPending.startedAt > this._uttMaxWaitMs) {
            this._flushStreamUtterance();
            this._uttPending = { parts: [], raws: [], startedAt: now, duringTts: false };
        }
        const p = this._uttPending;
        p.parts.push(text);
        if (raw) p.raws.push(raw);
        if (immediate) p.duringTts = true;
        diag.write('HOLD', `收到第 ${p.parts.length} 段: "${text.slice(0, 40)}"`
            + (immediate ? ' → 插话，整句立即提交' : ` → 等你说完 ${this._uttHoldMs}ms`));

        if (this._uttTimer) { clearTimeout(this._uttTimer); this._uttTimer = null; }
        if (immediate || this._uttHoldMs <= 0) {
            this._flushStreamUtterance();
            return;
        }
        if (p.parts.length === 1 && this._isDefinitiveClose(text)) {
            diag.write('HOLD', `首段为明确结束语 → 立即提交`);
            this._flushStreamUtterance();
            return;
        }
        if (p.parts.length === 1 && !this._looksIncomplete(text)) {
            diag.write('HOLD', `首段已完整 → 直接进跨句合并窗口`);
            this._flushStreamUtterance();
            return;
        }
        const remain = this._uttMaxWaitMs - (now - p.startedAt);
        const wait = Math.min(this._uttHoldMs, Math.max(0, remain));
        if (wait <= 0) { this._flushStreamUtterance(); return; }
        this._uttTimer = setTimeout(() => this._flushStreamUtterance(), wait);
    }

    
    _flushStreamUtterance() {
        if (this._uttTimer) { clearTimeout(this._uttTimer); this._uttTimer = null; }
        const p = this._uttPending;
        this._uttPending = null;
        if (!p || !p.parts.length) return;
        const text = p.parts.reduce((a, b) => this._joinText(a, b), '');
        const raw = p.raws.length
            ? p.raws.reduce((a, b) => this._joinText(a, b), '') : text;
        if (!text.trim()) return;
        diag.write('HOLD', `整句合并(${p.parts.length} 段): "${text.slice(0, 80)}"`);
        const _definitive = this._isDefinitiveClose(text);
        if (this._crossHoldMs > 0 && !p.duringTts && this._sheIdleNow() && !_definitive) {
            this._stashCrossPending(text, raw);
            return;
        }
        this._submitStreamUtterance(text, raw, { duringTts: p.duringTts });
    }

    _sheIdleNow() {
        const ttsPlaying = !!(this.isTtsPlaying && typeof this.isTtsPlaying === 'function'
            && this.isTtsPlaying());
        if (this.isProcessingAudio || ttsPlaying) return false;
        if (this.isSheReplying && typeof this.isSheReplying === 'function') {
            return !this.isSheReplying();
        }
        return true;
    }

    _stashCrossPending(text, raw) {
        if (this._crossTimer) { clearTimeout(this._crossTimer); this._crossTimer = null; }
        if (!this._crossPending) {
            this._crossPending = { text: '', raw: '', startedAt: Date.now(), duringTts: false };
        }
        this._crossPending.text = this._joinText(this._crossPending.text, text);
        this._crossPending.raw = this._joinText(this._crossPending.raw, raw);
        diag.write('HOLD', `她还没回应 → 暂存待合并("${this._crossPending.text.slice(0, 60)}")，`
            + `再等 ${this._crossHoldMs}ms 或她开口`);
        this._crossTimer = setTimeout(() => this._flushCrossPending('跨句窗口到期'), this._crossHoldMs);
    }

    _clearCrossPending(reason = '') {
        const had = !!(this._crossPending && this._crossPending.text.trim());
        if (this._crossTimer) { clearTimeout(this._crossTimer); this._crossTimer = null; }
        this._crossPending = null;
        if (had) diag.write('HOLD', `清空跨句缓冲(${reason})`);
    }

    _flushCrossPending(reason = '') {
        if (this._crossTimer) { clearTimeout(this._crossTimer); this._crossTimer = null; }
        const cp = this._crossPending;
        this._crossPending = null;
        if (!cp || !cp.text.trim()) return;
        diag.write('HOLD', `跨句提交(${reason}): "${cp.text.slice(0, 80)}"`);
        this._submitStreamUtterance(cp.text, cp.raw, { duringTts: cp.duringTts });
    }

    
    _submitStreamUtterance(text, raw, opts) {
        const _duringTts = !!(opts && opts.duringTts)
        const _ttsPlayingNow = !!(this.isTtsPlaying && typeof this.isTtsPlaying === 'function'
            && this.isTtsPlaying());
        if (this.isProcessingAudio || _duringTts || _ttsPlayingNow || this._ttsGateMayBeStuck) {
            this._streamSend({ tts: 0, interrupt: true });
            this._ttsGateMayBeStuck = false;
            
            this._clearCrossPending('文本门控打断');
            diag.write('BARGE', `文本门控打断：收到新文本 "${text.slice(0, 30)}" → 停止语音输出并撤掉后端 TTS 门控`);
        }
        this.clearBargeMute('真实文本已到达（转真停播）');
        if (typeof this.onSpeechRecognized !== 'function') return;
        try {
            this.onSpeechRecognized(text, raw, { duringTts: _duringTts });
        } catch (e) {
            diag.write('STREAM', `onSpeechRecognized 异常: ${(e && e.stack) || e}`);
            console.error('[STREAM] onSpeechRecognized 异常:', e);
        }
    }

    _onStreamMessage(ev) {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (!msg) return;
        if (msg.type === 'pong') {
            this._lastPongAt = Date.now();
            return;
        }
        if (msg.type === 'utterance') {
            const text = (msg.text || '').trim();
            if (!text) return;
            diag.write('STREAM', `收到文本: "${text.slice(0, 50)}"`);
            this._queueStreamUtterance(text, msg.raw || text,
                { duringTts: !!msg.during_tts });
        }
    }

    closeStream() {
        clearTimeout(this._wsRetryTimer);
        this._wsRetryTimer = null;
        if (this._connWatchdog) { clearTimeout(this._connWatchdog); this._connWatchdog = null; }
        this.clearBargeMute('关闭流式通道');
        if (this._uttTimer) { clearTimeout(this._uttTimer); this._uttTimer = null; }
        this._uttPending = null;
        if (this._crossTimer) { clearTimeout(this._crossTimer); this._crossTimer = null; }
        this._crossPending = null;
        this._deferredAudio = [];
        this._deferredAudioSize = 0;
        if (this._ws) {
            try { this._ws.onclose = null; this._ws.close(); } catch (e) {   }
        }
        this._ws = null;
        this._wsState = 'closed';
    }
}

module.exports = { ASRProcessor, diag };
