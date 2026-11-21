'use strict';

const DEFAULT_BASE = 'http://127.0.0.1:6006';
const DEFAULT_POLL_MS = 30000;

class SoundBridge {
    constructor(opts = {}) {
        const winBase = (typeof window !== 'undefined' && window.__neuroBackendBase);
        this.base = opts.base || winBase || DEFAULT_BASE;
        this.pollMs = opts.pollMs || DEFAULT_POLL_MS;
        this.emotion = '';
        this.emotionIntensity = 0.6;
        this.intent = null;
        this._emotionAt = 0;
        this._intentAt = 0;
        this.drives = null;
        this.valence = null;
        this.arousal = null;
        this.tension = null;
        this._mindAt = 0;
        this.event = null;
        this._eventAt = 0;
        this._timer = null;
        this._fetch = opts.fetch || ((...a) => {
            if (typeof fetch === 'function') return fetch(...a);
            return Promise.reject(new Error('no fetch'));
        });
    }

    setEmotion(name, intensity) {
        this.emotion = (typeof name === 'string' && name) ? name.toLowerCase() : '';
        const v = Number(intensity);
        this.emotionIntensity = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.6;
        this._emotionAt = Date.now();
    }

    setEvent(name) {
        this.event = (typeof name === 'string' && name) ? name : null;
        this._eventAt = this.event ? Date.now() : 0;
    }

    setMindStatus(data) {
        if (!data || typeof data !== 'object') return null;
        try {
            const d = (data.last && data.last.drives) || data.drives
                   || (data.drive && data.drive.drives) || null;
            if (d && typeof d === 'object') {
                const pick = (k) => {
                    const v = Number(d[k]);
                    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
                };
                this.drives = {
                    curiosity: pick('curiosity'), social: pick('social'),
                    rest: pick('rest'), order: pick('order'),
                    achievement: pick('achievement'), boredom: pick('boredom'),
                };
            }
            const ax = (data.drive && data.drive.axes) || data.axes || null;
            if (ax && typeof ax === 'object') {
                const pick = (k) => { const v = Number(ax[k]); return Number.isFinite(v) ? v : 0; };
                let v = pick('valence');
                if (v > 1 || v < -1) v = v * 2 - 1;
                this.valence = v;
                this.arousal = Math.max(0, Math.min(1, pick('arousal')));
                this.tension = Math.max(0, Math.min(1, pick('tension')));
            }
            if (d || ax) this._mindAt = Date.now();
            return { drives: this.drives, valence: this.valence,
                     arousal: this.arousal, tension: this.tension };
        } catch (e) {
            return null;
        }
    }

    async pollIntent() {
        try {
            const resp = await this._fetch(`${this.base}/v1/mind/status`, { timeout: 3000 });
            if (!resp || !resp.ok) return null;
            const data = await resp.json();
            this.setMindStatus(data);
            const it = data && data.intent;
            if (typeof it === 'string' && it) {
                if (it !== this.intent) {
                    this.intent = it;
                    this._intentAt = Date.now();
                }
            } else {
                this.intent = null;
            }
            return this.intent;
        } catch (e) {
            
            return null;
        }
    }

    start() {
        if (this._timer) return;
        this.pollIntent();
        this._timer = setInterval(() => this.pollIntent(), this.pollMs);
        if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    }

    stop() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }

    state() {
        const now = Date.now();
        const mindFresh = this._mindAt > 0 && (now - this._mindAt < 60000);
        return {
            emotion: (this.emotion && (now - this._emotionAt < 300000)) ? this.emotion : null,
            intent: (this.intent && (now - this._intentAt < 120000)) ? this.intent : null,
            emotionIntensity: this.emotionIntensity,
            drives: mindFresh && this.drives ? Object.assign({}, this.drives) : null,
            valence: mindFresh ? this.valence : null,
            arousal: mindFresh ? this.arousal : null,
            tension: mindFresh ? this.tension : null,
            event: (this.event && (now - this._eventAt < 30000)) ? this.event : null,
        };
    }
}

module.exports = { SoundBridge, DEFAULT_BASE, DEFAULT_POLL_MS };
