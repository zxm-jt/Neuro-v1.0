'use strict';

const SOUNDS = {
    welcome: [{ f: 659, d: 110, g: 0.9 }, { f: 880, d: 170, g: 1.0 }],
    chirp:   [{ f: 880, d: 70, g: 0.8 }, { f: 1174, d: 90, g: 0.9 }, { f: 1568, d: 130, g: 1.0 }],
    hum:     [{ f: 523, d: 190, g: 0.7 }, { f: 659, d: 240, g: 0.8 }],
    yawn:    [{ f: 392, d: 260, g: 0.7 }, { f: 330, d: 330, g: 0.6 }],
    giggle:  [{ f: 784, d: 60, g: 0.8 }, { f: 988, d: 60, g: 0.9 }, { f: 784, d: 60, g: 0.8 }, { f: 1174, d: 100, g: 1.0 }],
    curious: [{ f: 1046, d: 90, g: 0.8 }],

    happy:    [{ f: 659, d: 90, g: 0.9 }, { f: 880, d: 90, g: 1.0 }, { f: 1046, d: 140, g: 1.0 }],
    excited:  [{ f: 784, d: 70, g: 0.9 }, { f: 988, d: 70, g: 1.0 }, { f: 1174, d: 70, g: 1.0 }, { f: 1568, d: 120, g: 1.0 }],
    content:  [{ f: 523, d: 200, g: 0.7 }, { f: 587, d: 220, g: 0.75 }, { f: 659, d: 260, g: 0.8 }],
    purr:     [{ f: 220, d: 300, g: 0.6, type: 'triangle', vib: 22 }, { f: 196, d: 320, g: 0.55, type: 'triangle', vib: 20 }],

    sad:      [{ f: 587, d: 200, g: 0.7 }, { f: 494, d: 220, g: 0.65 }, { f: 392, d: 320, g: 0.6 }],
    pout:     [{ f: 440, d: 140, g: 0.7, slide: 349 }, { f: 392, d: 200, g: 0.6, slide: 330 }],
    sigh:     [{ f: 587, d: 180, g: 0.6, slide: 392 }, { f: 349, d: 300, g: 0.5, noise: true }],
    surprised:[{ f: 1318, d: 60, g: 0.9 }, { f: 1568, d: 110, g: 1.0 }],
    shy:      [{ f: 784, d: 80, g: 0.7 }, { f: 880, d: 100, g: 0.6 }, { f: 659, d: 160, g: 0.5 }],

    blink:    [{ f: 1200, d: 30, g: 0.5, slide: 900 }],
    tap:      [{ f: 880, d: 40, g: 0.7, type: 'triangle' }],
    pop:      [{ f: 523, d: 50, g: 0.8, slide: 1046, type: 'sine' }],
    sneeze:   [{ f: 392, d: 70, g: 0.6, slide: 294 }, { f: 784, d: 110, g: 0.9, noise: true, slide: 523 }],
    yup:      [{ f: 659, d: 70, g: 0.8 }, { f: 880, d: 100, g: 0.9 }],

    idea:     [{ f: 659, d: 70, g: 0.8 }, { f: 988, d: 70, g: 0.9 }, { f: 1318, d: 130, g: 1.0 }],
    fanfare:  [{ f: 523, d: 110, g: 0.9, type: 'square' }, { f: 659, d: 110, g: 0.9, type: 'square' }, { f: 784, d: 110, g: 0.9, type: 'square' }, { f: 1046, d: 200, g: 1.0 }],
    retreat:  [{ f: 523, d: 90, g: 0.6, slide: 220 }, { f: 330, d: 160, g: 0.5, slide: 165 }],
};

const IDLE_SOUNDS = ['hum', 'yawn'];
const RANDOM_SOUNDS = ['giggle', 'curious', 'hum', 'content', 'blink', 'pop'];

const EMOTION_SOUNDS = {
    happy: ['happy', 'giggle', 'content'],
    excited: ['excited', 'yup', 'idea'],
    sad: ['sad', 'sigh', 'pout'],
    shy: ['shy', 'giggle'],
    surprised: ['surprised', 'pop'],
    angry: ['pout', 'retreat'],
    neutral: ['hum', 'content'],
};

const INTENT_SOUNDS = {
    exploratory: ['curious', 'idea', 'pop'],
    social: ['chirp', 'welcome', 'yup'],
    mastery: ['fanfare', 'happy'],
    order: ['tap', 'content'],
    restful: ['yawn', 'sigh', 'purr'],
    avoidant: ['retreat', 'pout'],
};

const DEFAULTS = {
    enabled: true,
    volume: 0.18,
    cooldown_s: 45,
    welcome_cooldown_s: 120,
    max_per_10min: 6,    
    idle_ms: 300000,
    away_ms: 600000,
    random_chance: 0.06,
    emotion_enabled: false,
    intent_enabled: false,
    expressive_cooldown_s: 50,
    generative_enabled: true,   
    generative_chance: 0.15,    
};

function compileSpec(spec) {
    spec = (spec && typeof spec === 'object') ? spec : {};
    const mood = String(spec.mood || 'happy').toLowerCase();
    const contour = String(spec.contour || 'up').toLowerCase();
    const pitch = String(spec.pitch || 'mid').toLowerCase();
    const tempo = String(spec.tempo || 'mid').toLowerCase();
    const length = String(spec.length || 'short').toLowerCase();
    const timbre = String(spec.timbre || 'sine').toLowerCase();

    const baseMap = { low: 330, mid: 523, high: 784 };
    const base = baseMap[pitch] || 523;

    const scales = {
        happy:     [0, 4, 7, 12],
        excited:   [0, 4, 7, 11],
        calm:      [0, 5, 7, 12],
        content:   [0, 4, 7, 9],
        curious:   [0, 2, 7, 9],
        surprised: [0, 7, 12, 7],
        sad:       [0, 3, 7, 10],
        angry:     [0, 1, 6, 7],
        neutral:   [0, 2, 4, 7],
    };
    const scale = scales[mood] || scales.happy;

    const durMap = { slow: 260, mid: 150, fast: 80 };
    const dur = durMap[tempo] || 150;
    const countMap = { short: 2, medium: 3, long: 4 };
    const count = Math.min(6, Math.max(1, countMap[length] || 2));
    const type = ['sine', 'triangle', 'square', 'sawtooth'].includes(timbre) ? timbre : 'sine';

    const notes = [];
    for (let i = 0; i < count; i++) {
        let semis;
        switch (contour) {
            case 'down': semis = scale[scale.length - 1 - (i % scale.length)] - scale[scale.length - 1]; break;
            case 'flat': semis = 0; break;
            case 'arc': semis = i < count / 2 ? scale[i % scale.length] : scale[Math.max(0, count - 1 - i) % scale.length]; break;
            case 'wave': semis = (i % 2) ? 4 : 0; break;
            case 'up':
            default: semis = scale[i % scale.length]; break;
        }
        const f = Math.max(80, Math.min(4000, Math.round(base * Math.pow(2, semis / 12))));
        notes.push({ f, d: dur, g: Math.round((0.65 + 0.35 * (i + 1) / count) * 100) / 100, type });
    }
    return notes;
}

function _pick(pool, random) {
    const arr = Array.isArray(pool) && pool.length ? pool : ['curious'];
    const idx = Math.floor((Number(random) || 0) * 1000) % arr.length;
    return arr[idx];
}

function decideCuteSound(state = {}, cfg = {}) {
    const c = Object.assign({}, DEFAULTS, cfg);
    const s = Object.assign({
        now: Date.now(), speaking: false, idleMs: 0, justStarted: false,
        lastSoundAt: 0, lastWelcomeAt: 0, lastExpressiveAt: 0,
        soundsInWindow: 0, windowStartAt: 0, random: Math.random(),
    }, state);

    if (!c.enabled) return { play: false, sound: null, why: '配置关闭' };
    
    if (s.speaking) return { play: false, sound: null, why: '她在说话' };

    const since = (t) => (t > 0 ? s.now - t : Infinity);

    if (s.idleMs >= c.away_ms) {
        if (since(s.lastWelcomeAt) >= c.welcome_cooldown_s * 1000) {
            return { play: true, sound: 'welcome', why: `你回来了(静默${(s.idleMs / 60000).toFixed(0)}分钟)` };
        }
        return { play: false, sound: null, why: 'welcome 冷却中' };
    }

    if (s.justStarted) {
        if (since(s.lastSoundAt) >= c.cooldown_s * 1000) {
            return { play: true, sound: 'chirp', why: '启动问候' };
        }
        return { play: false, sound: null, why: '启动音冷却中' };
    }

    
    if (since(s.lastSoundAt) < c.cooldown_s * 1000) {
        return { play: false, sound: null, why: '冷却中' };
    }
    if (s.now - s.windowStartAt > 600000) {
        s.soundsInWindow = 0;   
    }
    if (s.soundsInWindow >= c.max_per_10min) {
        return { play: false, sound: null, why: '10分钟次数用尽' };
    }

    if (s.idleMs >= c.idle_ms) {
        const sound = IDLE_SOUNDS[Math.floor(s.random * IDLE_SOUNDS.length) % IDLE_SOUNDS.length];
        return { play: true, sound, why: `空闲${(s.idleMs / 60000).toFixed(0)}分钟` };
    }

    const expressiveReady = since(s.lastExpressiveAt) >= (c.expressive_cooldown_s || 50) * 1000;
    if (expressiveReady) {
        if (c.intent_enabled && s.intent && INTENT_SOUNDS[s.intent]) {
            return { play: true, sound: _pick(INTENT_SOUNDS[s.intent], s.random), why: `意图:${s.intent}` };
        }
        if (c.emotion_enabled && s.emotion && EMOTION_SOUNDS[s.emotion]) {
            return { play: true, sound: _pick(EMOTION_SOUNDS[s.emotion], s.random), why: `情绪:${s.emotion}` };
        }
    }

    if (s.random < c.random_chance) {
        const sound = _pick(RANDOM_SOUNDS, s.random);
        return { play: true, sound, why: '随机' };
    }

    return { play: false, sound: null, why: '没什么想说的' };
}

const _GEN_CLAMP = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const _GEN_NUM = (x, d) => { const v = Number(x); return Number.isFinite(v) ? v : d; };
const _GEN_LERP = (a, b, t) => a + (b - a) * t;

const _GEN_EMOTION_ANCHOR = {
    happy:     { v: 0.8,  a: 0.6,  t: 0.2 },
    excited:   { v: 0.85, a: 0.9,  t: 0.35 },
    content:   { v: 0.6,  a: 0.3,  t: 0.1 },
    calm:      { v: 0.5,  a: 0.25, t: 0.1 },
    curious:   { v: 0.55, a: 0.6,  t: 0.3 },
    surprised: { v: 0.4,  a: 0.95, t: 0.6 },
    shy:       { v: 0.3,  a: 0.5,  t: 0.5 },
    sad:       { v: -0.7, a: 0.25, t: 0.35 },
    angry:     { v: -0.7, a: 0.8,  t: 0.9 },
    neutral:   { v: 0.0,  a: 0.4,  t: 0.2 },
};

const _GEN_EVENT_BIAS = {
    juststarted:   { v: +0.25, a: +0.20, t: 0.00, curiosity: 0.2 },
    returned:      { v: +0.35, a: +0.25, t: 0.00, social: 0.5 },
    userpraise:    { v: +0.55, a: +0.25, t: -0.20, social: 0.4, achievement: 0.3 },
    usercorrected: { v: -0.55, a: +0.10, t: +0.35, avoid: 0.6 },
    discovered:    { v: +0.30, a: +0.35, t: +0.10, curiosity: 0.7 },
    novelty:       { v: +0.30, a: +0.35, t: +0.10, curiosity: 0.7 },
    explored:      { v: +0.30, a: +0.35, t: +0.10, curiosity: 0.7 },
    sleepy:        { v: -0.10, a: -0.45, t: -0.20, rest: 0.8 },
    drowsy:        { v: -0.10, a: -0.45, t: -0.20, rest: 0.8 },
};

function synthesizeForSituation(state = {}, cfg = {}) {
    const s = (state && typeof state === 'object') ? state : {};
    if (s.speaking) return null;
    const c = Object.assign({}, DEFAULTS, cfg);
    if (c.enabled === false || c.generative_enabled === false) return null;

    let rnd;
    if (typeof s.random === 'function') rnd = s.random;
    else if (s.random != null && Number.isFinite(Number(s.random))) {
        const v = Number(s.random);
        rnd = () => v;
    } else rnd = Math.random;
    const jitter = (amp) => (rnd() - 0.5) * 2 * amp;

    let emoName = '', emoIntensity = 0.6;
    if (typeof s.emotion === 'string') emoName = s.emotion.toLowerCase();
    else if (s.emotion && typeof s.emotion === 'object') {
        emoName = String(s.emotion.name || s.emotion.emotion || '').toLowerCase();
        emoIntensity = _GEN_CLAMP(_GEN_NUM(s.emotion.intensity, 0.6), 0, 1);
    }

    
    const anchor = _GEN_EMOTION_ANCHOR[emoName] || _GEN_EMOTION_ANCHOR.neutral;
    
    let valence = (s.valence == null) ? anchor.v : _GEN_NUM(s.valence, anchor.v);
    
    if (valence > 1 || valence < -1) valence = valence * 2 - 1;
    let arousal = (s.arousal == null) ? anchor.a : _GEN_NUM(s.arousal, anchor.a);
    let tension = (s.tension == null) ? anchor.t : _GEN_NUM(s.tension, anchor.t);

    const event = String(s.event || '').toLowerCase();
    const bias = _GEN_EVENT_BIAS[event] || {};
    valence = _GEN_CLAMP(valence + _GEN_NUM(bias.v, 0) + jitter(0.04), -1, 1);
    arousal = _GEN_CLAMP(arousal + _GEN_NUM(bias.a, 0) + jitter(0.04), 0, 1);
    tension = _GEN_CLAMP(tension + _GEN_NUM(bias.t, 0) + jitter(0.04), 0, 1);

    const rd = (s.drives && typeof s.drives === 'object') ? s.drives : {};
    const drives = {
        curiosity:   _GEN_CLAMP(_GEN_NUM(rd.curiosity, 0.25), 0, 1),
        social:      _GEN_CLAMP(_GEN_NUM(rd.social, 0.25), 0, 1),
        rest:        _GEN_CLAMP(_GEN_NUM(rd.rest, 0.20), 0, 1),
        order:       _GEN_CLAMP(_GEN_NUM(rd.order, 0.15), 0, 1),
        achievement: _GEN_CLAMP(_GEN_NUM(rd.achievement, 0.20), 0, 1),
        boredom:     _GEN_CLAMP(_GEN_NUM(rd.boredom, 0.20), 0, 1),
        avoid:       0,
    };
    for (const k of ['curiosity', 'social', 'rest', 'order', 'achievement']) {
        if (bias[k] != null) drives[k] = _GEN_CLAMP(drives[k] + bias[k], 0, 1);
    }
    drives.avoid = _GEN_CLAMP(_GEN_NUM(bias.avoid, 0), 0, 1);

    const hour = _GEN_NUM(s.timeOfDay, new Date().getHours());
    if (hour >= 23 || hour < 6) {
        arousal = _GEN_CLAMP(arousal - 0.12, 0, 1);
        drives.rest = _GEN_CLAMP(drives.rest + 0.20, 0, 1);
    }
    if (_GEN_NUM(s.idleMs, 0) >= 300000) {
        arousal = _GEN_CLAMP(arousal - 0.15, 0, 1);
        drives.rest = _GEN_CLAMP(drives.rest + 0.30, 0, 1);
    }

    const intent = String(s.intent || '').toLowerCase();
    const intentGain = (name) => (intent === name ? 0.5 : 0);

    const baseMidi = 64 + 11 * arousal + 5 * valence + jitter(1.2);
    const baseHz = 440 * Math.pow(2, (baseMidi - 69) / 12);

    const minor = [0, 3, 7, 10, 12];
    const major = [0, 4, 7, 11, 12];
    const vt = _GEN_CLAMP((valence + 1) / 2, 0, 1);
    const scale = major.map((m, i) => _GEN_LERP(minor[i], m, vt));

    const w = {
        explore: _GEN_CLAMP(drives.curiosity + intentGain('exploratory'), 0, 1.5),
        rest:    _GEN_CLAMP(drives.rest + intentGain('restful'), 0, 1.5),
        avoid:   _GEN_CLAMP(drives.avoid + intentGain('avoidant')
                            + (tension > 0.7 && valence < -0.2 ? tension - 0.7 : 0), 0, 1.5),
        mastery: _GEN_CLAMP(drives.achievement + intentGain('mastery'), 0, 1.5),
        social:  _GEN_CLAMP(drives.social + intentGain('social'), 0, 1.5),
        order:   _GEN_CLAMP(drives.order + intentGain('order'), 0, 1.5),
    };
    let dominant = 'rest', domV = -1;
    for (const k of Object.keys(w)) { if (w[k] > domV) { domV = w[k]; dominant = k; } }
    const wSum = Object.keys(w).reduce((a, k) => a + w[k], 0) || 1;
    const curve = (u) => (
        w.explore * (7 * u + 2.2 * Math.sin(u * Math.PI * 3)) +
        w.rest    * (-5 * u + 0.6) +
        w.avoid   * (-16 * u * u) +
        w.mastery * (9 * Math.sin(Math.PI * u)) +
        w.social  * (3.5 * Math.sin(u * Math.PI * 4)) +
        w.order   * (1.5 * ((u * 4) % 2))
    ) / wSum;

    const count = Math.round(_GEN_CLAMP(2 + 2.2 * arousal + 1.8 * tension + jitter(0.6), 2, 6));
    const dur = _GEN_CLAMP(240 - 120 * arousal - 70 * tension + jitter(20), 60, 320);

    const roughness = _GEN_CLAMP(tension * 0.7 + (1 - vt) * 0.3, 0, 1);
    const type = roughness > 0.72 ? 'sawtooth' : roughness > 0.45 ? 'triangle' : 'sine';
    const vib = arousal > 0.55 ? Math.round(_GEN_LERP(8, 26, (arousal - 0.55) / 0.45)) : 0;
    const breathy = _GEN_CLAMP((-valence + 0.2) / 1.2, 0, 1) > 0.5;
    const slideDown = w.avoid / wSum > 0.30;
    const descending = (dominant === 'rest' || dominant === 'avoid');

    const notes = [];
    for (let i = 0; i < count; i++) {
        const u = count === 1 ? 0 : i / (count - 1);
        const degIdx = descending ? scale.length - 1 - (i % scale.length) : (i % scale.length);
        const semi = scale[degIdx] + curve(u);
        const fHz = baseHz * Math.pow(2, semi / 12) * (1 + jitter(0.015));
        const f = Math.round(_GEN_CLAMP(fHz, 140, 3000));
        const g = _GEN_CLAMP(0.62 + 0.30 * (i + 1) / count + jitter(0.05), 0.30, 1);
        const note = {
            f,
            d: Math.round(_GEN_CLAMP(dur * (1 + jitter(0.12)), 40, 600)),
            g: Math.round(g * 100) / 100,
            type,
        };
        if (vib) note.vib = vib;
        if (slideDown && i === count - 1) note.slide = Math.max(140, Math.round(f * 0.7));
        if (breathy && i === count - 1) {
            note.noise = true;
            note.g = Math.round(g * 0.55 * 100) / 100;
        }
        notes.push(note);
    }

    const r3 = (x) => Math.round(x * 1000) / 1000;
    const spec = {
        source: 'generative',
        valence: r3(valence), arousal: r3(arousal), tension: r3(tension),
        baseMidi: Math.round(baseMidi * 100) / 100, baseHz: Math.round(baseHz),
        dominant,
        weights: { explore: r3(w.explore), rest: r3(w.rest), avoid: r3(w.avoid),
                   mastery: r3(w.mastery), social: r3(w.social), order: r3(w.order) },
        count, dur: Math.round(dur), type, vib, breathy, slideDown,
        emotion: emoName, intensity: r3(emoIntensity), intent, event,
        drives: { curiosity: r3(drives.curiosity), social: r3(drives.social),
                  rest: r3(drives.rest), order: r3(drives.order),
                  achievement: r3(drives.achievement), boredom: r3(drives.boredom) },
    };
    const why = `生成式[${dominant}]${event ? '/' + event : ''} v=${valence.toFixed(2)} a=${arousal.toFixed(2)}`;
    return { notes, why, spec };
}

class CuteSoundPlayer {
    constructor(cfg = {}) {
        this.cfg = Object.assign({}, DEFAULTS, cfg);
        this._ctx = null;
        this._master = null;
        this.lastSoundAt = 0;
        this.lastWelcomeAt = 0;
        this.lastExpressiveAt = 0;
        this.soundsInWindow = 0;
        this.windowStartAt = Date.now();
        this._started = false;
    }

    _ensureCtx() {
        if (this._ctx) return this._ctx;
        const AC = (typeof window !== 'undefined')
            && (window.AudioContext || window.webkitAudioContext);
        if (!AC) return null;
        try {
            this._ctx = new AC();
            this._master = this._ctx.createGain();
            this._master.gain.value = this.cfg.volume;
            this._master.connect(this._ctx.destination);
        } catch (e) {
            this._ctx = null;
        }
        return this._ctx;
    }

    
    playNotes(notes, soundName = '') {
        if (!Array.isArray(notes) || !notes.length || !this.cfg.enabled) return false;
        const ctx = this._ensureCtx();
        if (!ctx) return false;
        if (ctx.state === 'suspended') {
            try { ctx.resume(); } catch (e) {   }
            if (ctx.state === 'suspended') return false;
        }
        try {
            let t = ctx.currentTime + 0.01;
            for (const n of notes) {
                const dur = Math.max(0.03, (n.d || 120) / 1000);
                let src;
                if (n.noise) {
                    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
                    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
                    const data = buf.getChannelData(0);
                    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
                    src = ctx.createBufferSource();
                    src.buffer = buf;
                } else {
                    src = ctx.createOscillator();
                    src.type = n.type || 'sine';
                    src.frequency.setValueAtTime(Math.max(40, n.f || 440), t);
                    if (n.slide) {
                        try { src.frequency.exponentialRampToValueAtTime(Math.max(40, n.slide), t + dur); } catch (e) {}
                    }
                    if (n.vib && src.frequency) {
                        try {
                            const lfo = ctx.createOscillator();
                            const lfoGain = ctx.createGain();
                            lfo.frequency.value = n.vib;
                            lfoGain.gain.value = 18;
                            lfo.connect(lfoGain); lfoGain.connect(src.frequency);
                            lfo.start(t); lfo.stop(t + dur + 0.02);
                        } catch (e) {}
                    }
                }
                const g = ctx.createGain();
                const peak = Math.max(0.001, Math.min(1, n.g == null ? 1 : n.g));
                g.gain.setValueAtTime(0.0001, t);
                g.gain.linearRampToValueAtTime(peak, t + 0.01);
                g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
                src.connect(g); g.connect(this._master);
                src.start(t); src.stop(t + dur + 0.02);
                t += dur;
            }
            this.lastSoundAt = Date.now();
            if (soundName === 'welcome') this.lastWelcomeAt = this.lastSoundAt;
            if (Date.now() - this.windowStartAt > 600000) {
                this.windowStartAt = Date.now();
                this.soundsInWindow = 0;
            }
            this.soundsInWindow++;
            return true;
        } catch (e) {
            return false;
        }
    }

    
    play(sound) {
        const notes = SOUNDS[sound];
        if (!notes) return false;
        const ok = this.playNotes(notes, sound);
        if (ok && (EMOTION_SOUNDS && Object.values(EMOTION_SOUNDS).some(a => a.includes(sound))
                   || Object.values(INTENT_SOUNDS).some(a => a.includes(sound)))) {
            this.lastExpressiveAt = Date.now();
        }
        return ok;
    }

    improvise(spec) {
        const notes = compileSpec(spec);
        return this.playNotes(notes, '__improvised__');
    }

    tick(getState = () => ({})) {
        const st = Object.assign({
            now: Date.now(), speaking: false, idleMs: 0, justStarted: false,
        }, getState(), {
            lastSoundAt: this.lastSoundAt,
            lastWelcomeAt: this.lastWelcomeAt,
            lastExpressiveAt: this.lastExpressiveAt,
            soundsInWindow: this.soundsInWindow,
            windowStartAt: this.windowStartAt,
            justStarted: this._started ? false : true,
        });
        const d = decideCuteSound(st, this.cfg);
        if (d.play) {
            if (this.play(d.sound)) {
                this._started = true;
                return d;
            }
            return { play: false, sound: null, why: d.why + '（音频不可用）' };
        }
        if (st.justStarted) this._started = true;
        return d;
    }

    playSituation(state = {}, cfg = {}) {
        if (!this.cfg.enabled) return false;
        const c = Object.assign({}, this.cfg, cfg);
        if (c.generative_enabled === false) return false;
        const st = Object.assign({ now: Date.now(), random: Math.random() }, state || {});
        const gen = synthesizeForSituation(st, c);
        if (!gen) return false;
        return this.playNotes(gen.notes, '__generative__');
    }

    tickSituation(getState = () => ({})) {
        const ext = (typeof getState === 'function' ? getState() : getState) || {};
        if (!this.cfg.generative_enabled) return this.tick(() => ext);

        const st = Object.assign({
            now: Date.now(), speaking: false, idleMs: 0, justStarted: false,
            emotion: null, intent: null, drives: null, event: null,
            random: Math.random(), timeOfDay: new Date().getHours(),
        }, ext, {
            lastSoundAt: this.lastSoundAt,
            lastWelcomeAt: this.lastWelcomeAt,
            lastExpressiveAt: this.lastExpressiveAt,
            soundsInWindow: this.soundsInWindow,
            windowStartAt: this.windowStartAt,
            justStarted: this._started ? false : true,
        });

        if (!st.event) {
            if (st.justStarted) st.event = 'justStarted';
            else if (st.idleMs >= (this.cfg.away_ms || DEFAULTS.away_ms)) st.event = 'returned';
            else if (st.idleMs >= (this.cfg.idle_ms || DEFAULTS.idle_ms)) {
                const hr = Number.isFinite(Number(st.timeOfDay)) ? Number(st.timeOfDay) : new Date().getHours();
                st.event = (hr >= 22 || hr < 7) ? 'sleepy' : 'restfulIdle';
            }
        }

        const genChance = Number.isFinite(this.cfg.generative_chance)
            ? this.cfg.generative_chance : DEFAULTS.generative_chance;
        const gateCfg = Object.assign({}, this.cfg, {
            emotion_enabled: true,
            intent_enabled: true,
            random_chance: genChance,
        });
        const gate = decideCuteSound(st, gateCfg);
        if (!gate.play) {
            if (st.justStarted) this._started = true;
            return { play: false, sound: null, why: gate.why };
        }

        const gen = synthesizeForSituation(st, this.cfg);
        if (!gen) return { play: false, sound: null, why: '生成式静默' };
        
        const tag = gate.sound === 'welcome' ? 'welcome' : '__generative__';
        const ok = this.playNotes(gen.notes, tag);
        if (!ok) return { play: false, sound: null, why: gate.why + '（音频不可用）' };
        this._started = true;
        if (gate.why.indexOf('情绪') >= 0 || gate.why.indexOf('意图') >= 0) {
            this.lastExpressiveAt = Date.now();
        }
        return {
            play: true, sound: '__generative__', why: gen.why,
            spec: gen.spec, notes: gen.notes, trigger: gate.sound,
        };
    }

    playWelcome(idleMs) {
        if (!this.cfg.enabled) return false;
        const awayMs = (this.cfg.away_ms || DEFAULTS.away_ms);
        if (!(idleMs >= awayMs)) return false;
        if (this._speaking && this._speaking()) return false;
        if (this.lastWelcomeAt && Date.now() - this.lastWelcomeAt
            < (this.cfg.welcome_cooldown_s || DEFAULTS.welcome_cooldown_s) * 1000) return false;
        return this.play('welcome');
    }

    setSpeakingChecker(fn) {
        this._speaking = (typeof fn === 'function') ? fn : null;
    }
}

module.exports = {
    SOUNDS, DEFAULTS, IDLE_SOUNDS, RANDOM_SOUNDS, EMOTION_SOUNDS, INTENT_SOUNDS,
    decideCuteSound, compileSpec, CuteSoundPlayer,
    synthesizeForSituation,
};
