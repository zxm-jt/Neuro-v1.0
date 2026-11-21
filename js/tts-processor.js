const { normalizeEmotionKey } = require('./emotion-keys.js');
const EmotionClassifier = require('./emotion-classifier.js');
const EMO_TAG_RE = /[\[【]\s*[A-Za-z0-9_\u4e00-\u9fff \-\u2010-\u2015]{1,40}?\s*[\]】]/g;

const EMO_OPEN_TAIL = /[\[【]\s*[A-Za-z0-9_\u4e00-\u9fff \-]{0,40}$/;

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{3030}\u{303D}\u{2049}\u{203C}]/gu;

function stripEmoji(s) {
    if (!s) return s;
    return String(s)
        .replace(EMOJI_RE, '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\s+([,;:.!?])/g, '$1');
}

const TTS_PREFETCH = 7;

const TTS_SYNTH_TIMEOUT_MS = 20000;

const SENTENCE_END_CHARS = ['.', '!', '?', '。', '！', '？', '…', '‼', '⁇', '⁈', '⁉'];

const HARD_SEGMENT_CHARS = 120;

const HARD_SPLIT_CHARS_DEFAULT = 300;


function _cfgHardSplitChars(cfg) {
    const v = Number(cfg && cfg.tts && cfg.tts.hard_split_chars)
    if (!isFinite(v) || v < 40) return HARD_SPLIT_CHARS_DEFAULT
    return Math.min(600, Math.round(v))
}

const WORD_HOLD_MAX_MS = 400;

const SUBTITLE_MIN_UNIT_MS = 55;

const TTS_MUTE_INTENT_TTL_MS = 4000;

const TTS_PLAY_STALL_MS = 2500;

function findSentenceEnd(text, from) {
    for (let i = from; i < text.length; i++) {
        const ch = text.charAt(i);
        if (!SENTENCE_END_CHARS.includes(ch)) continue;
        if (ch === '.' && /\d/.test(text.charAt(i + 1))) continue;
        let j = i;
        while (j + 1 < text.length
            && SENTENCE_END_CHARS.includes(text.charAt(j + 1))
            && !(text.charAt(j + 1) === '.' && /\d/.test(text.charAt(j + 2)))) {
            j++;
        }
        return j + 1;
    }
    return -1;
}

class EnhancedTextProcessor {
    constructor(ttsUrl, onAudioDataCallback, onStartCallback, onEndCallback, config = null) {
        this.config = config || {};
        this.ttsUrl = ttsUrl;
        this.onAudioDataCallback = onAudioDataCallback;
        this.onStartCallback = onStartCallback;
        this.onEndCallback = onEndCallback;
        this.language = this.config.tts?.language || "zh";

        this._spokenLog = [];
        this._lastSpeakEndAt = 0;

        this.textSegmentQueue = [];
        this.audioDataQueue = [];

        this.isProcessing = false;
        this._audioPlaying = false;
        this.shouldStop = false;

        this._segToken = 0;

        this.onEmotionCallback = null;
        this.onExpressionOnlyCallback = null;
        this.onExpressionRelaxCallback = null;
        this._exprOnlyTimer = null;
        this.currentEmotion = null;
        this._roundEmotion = null;
        this._tagHold = '';
        this._wordHold = '';
        this._wordHoldAt = 0;
        this._punctHold = '';
        this._sentenceBuf = '';

        this.audioContext = null;
        this.analyser = null;
        this._pgIdx = 0;
        this._pgText = '';
        this._pgTotal = 1;
        this._pgMax = 350;
        this.dataArray = null;
        this.currentAudio = null;

        this.punctuations = [',', '.', '?', '!', '。', '，', '？', '！', '；', ';', '：', ':', '\n'];
        this.maxSegmentChars = 70;

        
        this._softBoundaries = [',', '.', '?', '!', ';', ':', '，', '。', '？', '！', '；', '：', ' '];

        this.currentFullText = '';

        this.pendingSegment = '';

        this.llmFullResponse = '';     
        this.displayedText = '';
        this._liveSubtitleText = '';   
        this.currentSegmentText = '';
        this._curSegRatePct = '-15%';
        this.syncTextQueue = [];
        this._ttsSeq = 0;
        this._ttsEpoch = 0;
        this._nextSeqToPush = 0;
        this._pendingAudios = new Map();

        this._spokenText = '';
        this._completedSegments = [];
        this.currentTurn = 0;
        this._currentTurn = 0;

        this._aiEmotionSeq = null;
        this._sentIdx = 0;
        this._sentIdxTurn = -1;

        this._spokenOffset = 0;
        this._curSegTotal = 0;
        this._curSegRevealed = 0;

        this.startProcessingThread();
        this.startPlaybackThread();
    }

    async initAudioContext() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
            this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
        }
    }

    
    startProcessingThread() {
        if (this._procTimer) return;
        const processNextSegment = async () => {
            if (this.shouldStop) { this._procTimer = null; return; }

            try {
                if ((this._synthInFlight || 0) > 0
                    && this._synthWatchAt
                    && (Date.now() - this._synthWatchAt) > 90000) {
                    console.warn('[tts] 合成看门狗：在途合成 ' + this._synthInFlight
                        + ' 段超过 90s 无进展，强制清零以释放语音锁');
                    this._synthInFlight = 0;
                    this._synthWatchAt = 0;
                    if (!this._audioPlaying
                        && this.audioDataQueue.length === 0
                        && this.textSegmentQueue.length === 0
                        && (this.pendingSegment || '').trim() === '') {
                        this._fireEnd();
                    }
                }
            } catch (e) {   }

            if (this.textSegmentQueue.length > 0 && !this.isProcessing
                && (this._synthInFlight || 0) < TTS_PREFETCH) {
                this.isProcessing = true;

                const batch = this.textSegmentQueue.splice(0, TTS_PREFETCH);

                
                for (const item of batch) this.syncTextQueue.push(item.text);

                
                this._synthInFlight = (this._synthInFlight || 0) + batch.length;
                this._synthWatchAt = Date.now();

                this._pendingAudios = this._pendingAudios || new Map();
                const _epoch = this._ttsEpoch || 0;
                const batchSeq = batch.map(() => this._ttsSeq++);
                const flushPending = () => {
                    while (this._pendingAudios.has(this._nextSeqToPush)) {
                        const it = this._pendingAudios.get(this._nextSeqToPush);
                        this._pendingAudios.delete(this._nextSeqToPush);
                        this._nextSeqToPush++;
                        if (it) {
                            this.audioDataQueue.push({
                                audio: it.audio,
                                text: it.text,
                                emotion: it.emotion,
                                pageIdx: it.pageIdx,
                                pageBase: it.pageBase,
                                turn: (it.turn !== undefined) ? it.turn : this._currentTurn
                            });
                        }
                    }
                };

                batch.forEach((item, i) => {
                    const seq = batchSeq[i];
                    this.convertTextToSpeech(item.text, item.emotion || 'neutral')
                        .then((audio) => {
                            if ((this._ttsEpoch || 0) !== _epoch) return;
                            this._pendingAudios.set(seq, { audio, text: item.text, emotion: item.emotion,
                                pageIdx: item.pageIdx, pageBase: item.pageBase,
                                turn: item.turn });
                            flushPending();
                        })
                        .catch((error) => {
                            if ((this._ttsEpoch || 0) !== _epoch) return;
                            console.error('TTS处理错误:', error);
                            this._pendingAudios.set(seq, null);
                            flushPending();
                        })
                        .finally(() => {
                            this._synthInFlight = Math.max(0, (this._synthInFlight || 0) - 1);
                            if ((this._ttsEpoch || 0) === _epoch
                                && !this._audioPlaying
                                && (this._synthInFlight || 0) === 0
                                && this.audioDataQueue.length === 0
                                && this.textSegmentQueue.length === 0
                                && (this.pendingSegment || '').trim() === '') {
                                this._fireEnd();
                            }
                        });
                });

                this.isProcessing = false;
            }

            this._procTimer = setTimeout(processNextSegment, 16);
        };

        this._procTimer = setTimeout(processNextSegment, 16);
    }

    
    startPlaybackThread() {
        if (this._playTimer) return;
        const playNextAudio = async () => {
            if (this.shouldStop) { this._playTimer = null; return; }

            if (this.audioDataQueue.length > 0 && !this._audioPlaying) {
                const audioPackage = this.audioDataQueue.shift();

                this.currentTurn = (typeof audioPackage.turn === 'number')
                    ? audioPackage.turn : this._currentTurn;

                this._curPage = {
                    idx: (typeof audioPackage.pageIdx === 'number') ? audioPackage.pageIdx : 0,
                    base: audioPackage.pageBase || '',
                    total: this._pgTotal || 1
                };
                try {
                    if (typeof global.updateSubtitlePage === 'function') {
                        global.updateSubtitlePage(this._curPage.idx + 1, this._curPage.total);
                    }
                } catch (e) {   }

                this.currentSegmentText = audioPackage.text;
                try {
                    const _p = this._resolveProsody(audioPackage.emotion);
                    this._curSegRatePct = (_p && _p.rate)
                        || ((this.config && this.config.tts && this.config.tts.rate) || '-15%');
                } catch (e) { this._curSegRatePct = '-15%'; }
                if (audioPackage.text) {
                    this._spokenLog.push({ text: audioPackage.text, at: Date.now() });
                    const _now = Date.now();
                    const _KEEP_MS = 60000;
                    const _MAX_ENTRIES = 40;
                    if (this._spokenLog.length > _MAX_ENTRIES
                        || (_now - (this._spokenLog[0].at || 0)) > _KEEP_MS) {
                        this._spokenLog = this._spokenLog
                            .filter((e) => (_now - (e.at || _now)) <= _KEEP_MS)
                            .slice(-_MAX_ENTRIES);
                    }
                }
                this.currentSegmentEmotion = audioPackage.emotion;
                if (audioPackage.emotion) this.setEmotion(audioPackage.emotion);

                await this.playAudioWithTextSync(audioPackage.audio);
            }

            this._playTimer = setTimeout(playNextAudio, 16);
        };

        this._playTimer = setTimeout(playNextAudio, 16);
    }

    _stripOutlinePrefix(text) {
        let t = String(text || '').trim();
        if (!t) return t;
        const patterns = [
            /^(here'?s?|here\s+is|so|okay|ok|well|alright)[^.:!?]{0,40}?(here'?s?|my points?|the points?|what i (think|want to say|would do|would say)|how i'?d (do|say)|let me)[^.:!?]{0,30}[:：]\s*/i,
            /^(so|and)?\s*(my|the)\s+points?\s+(are|would be)\s*[:：]\s*/i,
            /^(let me|allow me to)\s+(outline|list|tell you|break (this|it) down)\s*[:：]?\s*/i,
            /^\s*(?:\d+\s*[\)\.、]\s*)/,
        ];
        for (const re of patterns) {
            const before = t;
            t = t.replace(re, '');
            if (t !== before && t.trim()) {
                t = t.replace(/^[\s,，、:：\-—]+/, '').trim();
                if (t) return t;
            }
        }
        return t;
    }

    _streamEnabled() {
        if (this.config && this.config.tts && this.config.tts.stream === false) return false;
        if (typeof MediaSource === 'undefined') return false;
        try { return !!MediaSource.isTypeSupported('audio/mpeg'); } catch (e) { return false; }
    }

    _streamUrl() {
        const u = String(this.ttsUrl || '');
        if (!u) return ''
        return /\/v3$/.test(u) ? u + '/stream' : u.replace(/\/v3\/?$/, '/v3/stream')
    }

    _openAudioStream(body) {
        const t0 = (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now()
        const nowMs = () => ((typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now()) - t0

        const ms = new MediaSource()
        const url = URL.createObjectURL(ms)
        const audio = new Audio(url)
        audio.preload = 'auto'
        audio.volume = (this._targetVolume !== undefined) ? this._targetVolume : 1.0

        let sb = null
        let disposed = false
        let firstResolve = null, firstReject = null
        const firstChunk = new Promise((res, rej) => { firstResolve = res; firstReject = rej })
        firstChunk.catch(() => {   })
        let doneResolve = null
        const done = new Promise((res) => { doneResolve = res })

        const canAbort = (typeof AbortController !== 'undefined')
        const ac = canAbort ? new AbortController() : null
        const _timeout = Number(this._synthTimeoutMs) > 0 ? Number(this._synthTimeoutMs) : TTS_SYNTH_TIMEOUT_MS
        let killTimer = setTimeout(() => { try { if (ac) ac.abort() } catch (e) {} }, _timeout)

        const dispose = () => {
            if (disposed) return
            disposed = true
            clearTimeout(killTimer)
            try { if (ac) ac.abort() } catch (e) {   }
            try { URL.revokeObjectURL(url) } catch (e) {   }
        }

        ms.addEventListener('sourceopen', async () => {
            try {
                sb = ms.addSourceBuffer('audio/mpeg')
            } catch (e) {
                try { firstReject(e) } catch (e2) {}
                doneResolve()
                return
            }
            let first = true
            try {
                const resp = await fetch(this._streamUrl(), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: ac ? ac.signal : undefined,
                })
                if (!resp.ok || !resp.body) throw new Error('stream HTTP ' + resp.status)
                const reader = resp.body.getReader()
                for (;;) {
                    const { done: rd, value } = await reader.read()
                    if (rd) break
                    if (disposed) break
                    if (!value || !value.length) continue
                    sb.appendBuffer(value)
                    
                    await new Promise((res) => sb.addEventListener('updateend', res, { once: true }))
                    if (first) {
                        first = false
                        try { firstResolve(nowMs()) } catch (e) {   }
                    }
                }
                try { if (ms.readyState === 'open' && !sb.updating) ms.endOfStream() } catch (e) {   }
                doneResolve()
            } catch (e) {
                
                if (first) { try { firstReject(e) } catch (e2) {   } }
                doneResolve()
            } finally {
                clearTimeout(killTimer)
            }
        })

        return { __stream: true, audio, firstChunk, done, dispose, url }
    }

    _durOf(audio) {
        try {
            const d = audio.duration
            if (d && isFinite(d) && d > 0) return d
            if (audio.buffered && audio.buffered.length) {
                const end = audio.buffered.end(audio.buffered.length - 1)
                if (end && isFinite(end) && end > 0) return end
            }
        } catch (e) {   }
        return 0
    }

    
    
    _timelineDur(audio, text) {
        try {
            const d = audio && audio.duration
            if (d && isFinite(d) && d > 0) return { dur: d, exact: true }
        } catch (e) {   }
        const est = this._estimateSpeechSeconds(text || '', this._curSegRatePct)
        const buffered = this._durOf(audio)
        return { dur: Math.max(est, buffered || 0), exact: false }
    }

    
    
    
    _estimateSpeechSeconds(text, rateStr) {
        const s = String(text || '')
        if (!s) return 0
        const m = /([+-]?\d+(?:\.\d+)?)/.exec(String(rateStr || ''))
        const rate = (m ? Number(m[1]) : -15) / 100
        let perCh = 0.0218 - 0.0394 * rate
        if (!(perCh > 0.005)) perCh = 0.005
        let units = 0
        for (const ch of s) {
            units += /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(ch) ? 1.6 : 1
        }
        return Math.max(0.4, 0.75 + units * perCh)
    }

    async convertTextToSpeech(text, emotion) {
        try {
            const textForTTS = this._stripOutlinePrefix(text)
                .replace(/（.*?）|\(.*?\)/g, '')
                .replace(/\*.*?\*/g, '')
                .replace(/[\[【][^\]】]{0,12}[\]】]/g, '')
                .replace(/[\[【][a-zA-Z_]{0,12}$/g, '')
                .replace(/^[a-zA-Z_]{0,12}[\]】]/g, '')
                .trim();

            if (!textForTTS) return null;

            const body = { text: textForTTS, text_language: this.language };
            const prosody = this._resolveProsody(emotion);
            if (prosody) {
                if (prosody.pitch) body.pitch = prosody.pitch;
                if (prosody.rate) body.rate = prosody.rate;
            }

            
            if (this._streamEnabled() && this._streamUrl()) {
                const src = this._openAudioStream(body)
                try {
                    await Promise.race([
                        src.firstChunk,
                        new Promise((_, rej) => setTimeout(() => rej(new Error('首块音频超时(8s)')), 8000)),
                    ])
                    return src
                } catch (e) {
                    console.warn('[tts] 流式合成不可用，回落到整段合成:', e && e.message)
                    try { src.dispose() } catch (e2) {   }
                    
                }
            }

            const response = await this._fetchTtsWithTimeout(body);

            if (!response.ok) {
                throw new Error('TTS请求失败: ' + response.status);
            }

            return await response.blob();
        } catch (error) {
            if (error && error.name === 'AbortError') {
                const _ms = Number(this._synthTimeoutMs) > 0 ? Number(this._synthTimeoutMs) : TTS_SYNTH_TIMEOUT_MS
                console.warn('[tts] 合成超时（' + _ms + 'ms），丢弃本段，锁照常释放');
            } else {
                console.error('TTS转换错误:', error);
            }
            return null;
        }
    }

    async _fetchTtsWithTimeout(body) {
        const _timeout = Number(this._synthTimeoutMs) > 0 ? Number(this._synthTimeoutMs) : TTS_SYNTH_TIMEOUT_MS;
        const canAbort = (typeof AbortController !== 'undefined');
        const ac = canAbort ? new AbortController() : null;
        let timer = null;
        if (ac) {
            timer = setTimeout(() => {
                try { ac.abort(); } catch (e) {   }
            }, _timeout);
        }
        try {
            return await fetch(this.ttsUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body),
                signal: ac ? ac.signal : undefined
            });
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async playAudioWithTextSync(audioBlob) {
        if (!audioBlob) return;

        this._healStuckMuteVolume();

        return new Promise((resolve) => {
            if (this.shouldStop) { resolve(); return; }

            this._audioPlaying = true;
            const _isStream = !!(audioBlob && audioBlob.__stream);
            let audioUrl = null;
            let audio = null;
            if (_isStream) {
                audio = audioBlob.audio;
            } else {
                audioUrl = URL.createObjectURL(audioBlob);
                audio = new Audio(audioUrl);
            }
            const _disposeSrc = () => {
                try { if (_isStream && audioBlob.dispose) audioBlob.dispose(); } catch (e) {   }
                try { if (audioUrl) URL.revokeObjectURL(audioUrl); } catch (e) {   }
            };
            audio.volume = (this._targetVolume !== undefined) ? this._targetVolume : 1.0;
            this.currentAudio = audio;

            this._endFired = false;
            if (this._endGuard) { clearTimeout(this._endGuard); this._endGuard = null; }
            if (this.onStartCallback) this.onStartCallback();

            const segmentText = this.currentSegmentText;
            const units = this._revealUnits(segmentText);
            const total = units.length;
            this._curSegTotal = total;
            this._curSegRevealed = 0;
            const baseText = (this._curPage && typeof this._curPage.base === 'string')
                ? this._curPage.base : this.displayedText;
            const _myToken = (this._segToken = (this._segToken || 0) + 1);

            
            
            
            
            let _lockedDur = 0;
            let _durExact = false;
            let _durCorrected = false;
            {
                const tl = this._timelineDur(audio, segmentText);
                _lockedDur = tl.dur;
                _durExact = tl.exact;
            }
            
            let _lastSmoothCt = -1;
            let _lastSmoothAt = now();

            let _lastCt = -1;
            let _ctStallSince = 0;
            const now = (typeof performance !== 'undefined' && performance.now)
                ? () => performance.now() : () => Date.now();

            const revealUpTo = (n) => {
                if (_myToken !== this._segToken) return;
                const upto = units.slice(0, n).map(u => u.text).join('');
                
                
                this._liveSubtitleText = this._joinSubtitle(baseText, upto);
                if (typeof showSubtitle === 'function') {
                    showSubtitle(this._liveSubtitleText);
                    const c = document.getElementById('subtitle-container');
                    if (c) c.scrollTop = c.scrollHeight;
                }
            };

            
            
            let _lastMouthCt = -1;
            let _mouthMovedAt = now();
            const updateMouth = () => {
                if (this.shouldStop || this.currentAudio !== audio) return;
                let mv = 0;
                if (!audio.paused && !audio.ended) {
                    const ct = audio.currentTime || 0;
                    if (ct !== _lastMouthCt) { _lastMouthCt = ct; _mouthMovedAt = now(); }
                    if (ct > 0 && (now() - _mouthMovedAt) < 160) mv = this.syntheticMouthValue(ct);
                }
                if (this.onAudioDataCallback) this.onAudioDataCallback(mv);
                if (this.currentAudio === audio) requestAnimationFrame(updateMouth);
            };

            const syncSubtitle = () => {
                if (_myToken !== this._segToken || this.currentAudio !== audio) return;
                
                
                if (!_durExact && !_durCorrected) {
                    try {
                        const d = audio.duration;
                        if (d && isFinite(d) && d > 0) {
                            if (d > _lockedDur) { _lockedDur = d; }
                            _durExact = true;
                            _durCorrected = true;
                        }
                    } catch (e) {  }
                }
                const ct = audio.currentTime || 0;
                
                
                const _audiblyAdvancing = !audio.paused && !audio.ended
                    && (!_isStream || audio.readyState >= 3);
                if (ct !== _lastSmoothCt) {
                    _lastSmoothCt = ct;
                    _lastSmoothAt = now();
                } else if (!_audiblyAdvancing) {
                    _lastSmoothAt = now();
                }
                const _smoothCt = _audiblyAdvancing
                    ? _lastSmoothCt + Math.min(500, Math.max(0, (now() - _lastSmoothAt) / 1000))
                    : _lastSmoothCt;
                const ctUse = Math.max(ct, _smoothCt);
                let prog = _lockedDur > 0 ? (Math.max(0, ctUse) / _lockedDur) : 0;
                if (!_durExact && !audio.ended) prog = Math.min(prog, 0.99);
                prog = Math.max(0, Math.min(1, prog));
                const n = Math.min(total, Math.floor(prog * total) + (prog > 0 ? 1 : 0));
                if (n > this._curSegRevealed) { this._curSegRevealed = n; revealUpTo(n); }
            };
            const _syncLoop = () => {
                if (_myToken !== this._segToken || this.currentAudio !== audio) { this._subSyncRAF = null; return; }
                syncSubtitle();
                const _ct = audio.currentTime || 0;
                if (_isStream && audio.readyState < 3) {
                    _lastCt = _ct;
                    _ctStallSince = 0;
                } else if (_ct !== _lastCt) {
                    _lastCt = _ct;
                    _ctStallSince = 0;
                } else if (!_ctStallSince) {
                    _ctStallSince = now();
                } else if (now() - _ctStallSince > TTS_PLAY_STALL_MS) {
                    console.error('[TTS] 播放卡死：currentTime 停滞 '
                        + Math.round(now() - _ctStallSince) + 'ms，判定为无声卡死 → 跳过本段');
                    if (typeof global.__neuroTtsDiag === 'function') {
                        try { global.__neuroTtsDiag('播放卡死 ' + Math.round(now() - _ctStallSince) + 'ms → 跳过本段'); } catch (e) {}
                    }
                    try { audio.pause(); } catch (e) {   }
                    if (typeof Event === 'function') {
                        try { audio.dispatchEvent(new Event('ended')); } catch (e) {   }
                    }
                    this.currentAudio = null;
                    this._audioPlaying = false;
                    _disposeSrc();
                    this._subSyncRAF = null;
                    resolve();
                    return;
                }
                if (!audio.ended && this.currentAudio === audio) {
                    this._subSyncRAF = requestAnimationFrame(_syncLoop);
                } else {
                    
                    
                    if (total > 0 && this._curSegRevealed < total) {
                        this._curSegRevealed = total;
                        revealUpTo(total);
                    }
                    this._subSyncRAF = null;
                }
            };

            audio.ontimeupdate = () => syncSubtitle();
            audio.onplay = () => { revealUpTo(0); };

            audio.onended = () => {
                if (this._subSyncRAF) { cancelAnimationFrame(this._subSyncRAF); this._subSyncRAF = null; }
                if (total > 0) { this._curSegRevealed = total; revealUpTo(total); }
                
                if (this.onAudioDataCallback) {
                    let mv = 0.6;
                    const close = () => {
                        mv -= 0.15;
                        if (mv <= 0) { this.onAudioDataCallback(0); return; }
                        this.onAudioDataCallback(mv);
                        requestAnimationFrame(close);
                    };
                    close();
                }
                if (_myToken === this._segToken) {
                    this.displayedText = this._joinSubtitle(this.displayedText, this.currentSegmentText);
                    this._spokenOffset += (this.currentSegmentText || '').length;
                    this._spokenText = this._joinSubtitle(this._spokenText || '', this.currentSegmentText || '');
                    this._completedSegments.push(this.currentSegmentText || '');
                }
                _disposeSrc();
                this.currentAudio = null;
                this._audioPlaying = false;

                const _synthPending = (this._synthInFlight || 0) > 0
                    || (this._pendingAudios && this._pendingAudios.size > 0);
                if (this.audioDataQueue.length === 0 &&
                    this.textSegmentQueue.length === 0 &&
                    !this.isProcessing &&
                    !_synthPending &&
                    this.pendingSegment.trim() === '') {
                    this._fireEnd();
                }
                resolve();
            };

            audio.onerror = (e) => {
                console.error('音频播放错误:', e);
                if (this._subSyncRAF) { cancelAnimationFrame(this._subSyncRAF); this._subSyncRAF = null; }
                _disposeSrc();
                this.currentAudio = null;
                this._audioPlaying = false;
                resolve();
            };

            
            updateMouth();
            revealUpTo(0);
            this._subSyncRAF = requestAnimationFrame(_syncLoop);

            audio.play().catch(error => {
                console.error('播放失败:', error);
                if (this._subSyncRAF) { cancelAnimationFrame(this._subSyncRAF); this._subSyncRAF = null; }
                _disposeSrc();
                this.currentAudio = null;
                this._audioPlaying = false;
                resolve();
            });
        });
    }

static stripEmotionTags(s) {
        if (!s) return s;
        let out = String(s).replace(EMO_TAG_RE, '');
        out = out.replace(/([,;:])(?=\s*[,.!?;:])/g, '');
        out = out.replace(/([,;:])\s*\1+/g, '$1');
        out = out.replace(/\s+([,;:.!?，。；：！？])/g, '$1');
        out = out.replace(/[ \t]{2,}/g, ' ');
        return out.trimStart();
    }

    static EMO_PROSODY = {
        happy:     { pitch: "+48Hz", rate: "+6%"  },
        excited:   { pitch: "+50Hz", rate: "+10%" },
        angry:     { pitch: "+45Hz", rate: "+10%" },
        shy:       { pitch: "+40Hz", rate: "-4%"  },
        sad:       { pitch: "+34Hz", rate: "-12%" },
        surprised: { pitch: "+50Hz", rate: "+2%"  },
        worried:   { pitch: "+36Hz", rate: "-6%"  },
        blush:        { pitch: "+42Hz", rate: "-6%"  },
        look_down:    { pitch: "+38Hz", rate: "-8%"  },
        starry_eyes:  { pitch: "+50Hz", rate: "+8%"  },
        gentle_smile: { pitch: "+40Hz", rate: "-4%"  },
        thoughtful:   { pitch: "+36Hz", rate: "-6%"  },
        curious:      { pitch: "+46Hz", rate: "+6%"  },
        concerned:    { pitch: "+34Hz", rate: "-8%"  },
        playful:       { pitch: "+46Hz", rate: "+8%"  },
        bored:         { pitch: "+32Hz", rate: "-10%" },
        neutral:   null,
    };

    static _parseHz(v, def) {
        const m = /([+-]?\d+(?:\.\d+)?)/.exec(String(v || ''));
        return m ? Number(m[1]) : def;
    }

    static _parsePct(v, def) {
        const m = /([+-]?\d+(?:\.\d+)?)/.exec(String(v || ''));
        return m ? Number(m[1]) : def;
    }

    static PROSODY_BASE = { pitchHz: 42, ratePct: -15 };

    
    
    
    _resolveProsody(emotion) {
        const emo = EnhancedTextProcessor.EMO_PROSODY[emotion];
        if (!emo) return null;
        const cfgTts = (this.config && this.config.tts) || {};
        const basePitch = EnhancedTextProcessor._parseHz(cfgTts.pitch, 42);
        const baseRate = EnhancedTextProcessor._parsePct(cfgTts.rate, -15);
        const num = (v, def) => (typeof v === 'number' && isFinite(v)) ? v : def;
        const pitchScale = Math.max(0, Math.min(3, num(cfgTts.emotion_pitch_scale, 0)));
        const rateScale = Math.max(0, Math.min(2, num(cfgTts.emotion_rate_scale, 0.45)));
        const B = EnhancedTextProcessor.PROSODY_BASE;
        const dPitch = (EnhancedTextProcessor._parseHz(emo.pitch, B.pitchHz) - B.pitchHz) * pitchScale;
        const dRate = (EnhancedTextProcessor._parsePct(emo.rate, B.ratePct) - B.ratePct) * rateScale;
        const pitch = Math.max(0, Math.min(90, basePitch + dPitch));
        const rate = Math.max(-40, Math.min(40, baseRate + dRate));
        return {
            pitch: (pitch >= 0 ? '+' : '') + Math.round(pitch) + 'Hz',
            rate: (rate >= 0 ? '+' : '') + Math.round(rate) + '%',
        };
    }

    static classifyEmotion(text) {
        if (!text) return 'neutral';
        const t = text.toLowerCase();
        const bang = (text.match(/[!！]/g) || []).length;
        const nHits = (re) => (t.match(re) || []).length;

        
        if (bang >= 3) return 'angry';
        if (/\b(shut up|go away|stupid|idiot|damn you|hell no|forget it|stop it)\b/.test(t)) return 'angry';
        if (/可恶|讨厌|烦死|滚开|混蛋|气死|闭嘴|胡说八道/.test(t)) return 'angry';
        if (/[A-Z]{5,}/.test(text)) return 'angry';

        if (/哈{2,}|嘻嘻|嘿嘿|太好啦|好耶|耶[!！]|太棒了|好开心|开心极|♪/.test(t)) return 'happy';
        if (nHits(/[!！]/g) >= 2) return 'happy';
        if (/\b(i love it|this is great|awesome|amazing|so happy|yay)\b/.test(t)) return 'happy';

        if (/\b(blush|shy|embarrassed|flustered)\b/.test(t)) return 'shy';
        if (/害羞|脸红|才没有|别看我/.test(t)) return 'shy';

        if (/呜{1,}|难过|伤心|想哭|好寂寞|唉{1,}[，。]?/.test(t)) return 'sad';
        if (/\b(i'?m (so )?sad|don'?t cry|feeling lonely|miss you so much|heartbroken|lonely)\b/.test(t)) return 'sad';

        
        if (/不会吧|真的吗|天哪|哇哦/.test(t)) return 'surprised';
        if (/\b(omg|wtf|what the|you'?re kidding|no way|unbelievable)\b/.test(t)) return 'surprised';
        if (/[？?][！!]|[！!][？?]/.test(text)) return 'surprised';

        
        if (/\b(i'?m worried|i'?m scared|that'?s scary|we'?re in trouble|help me)\b/.test(t)) return 'worried';
        if (/怎么办|好害怕|糟了|出事了|救救我/.test(t)) return 'worried';

        if (/激动|好兴奋|冲冲冲|冲鸭/.test(t)) return 'excited';
        if (/\b(let'?s go+|let'?s do it|i'?m so excited|this is amazing)\b/.test(t)) return 'excited';

        if (/\b(lalala|just kidding|i'?m kidding|teasing you|silly idea|pretending)\b/.test(t)) return 'playful';
        if (/啦啦啦|开玩笑|假装|调皮/.test(t)) return 'playful';
        if (/\b(bored|boredom|so boring|not interested in this)\b/.test(t)) return 'bored';
        if (/无聊|没意思|提不起劲/.test(t)) return 'bored';

        return 'neutral';
    }

    setRoundEmotion(name) {
        if (!name) return;
        const raw = String(name).toLowerCase();
        const norm = normalizeEmotionKey(raw);
        this._roundEmotion = norm || raw;
        if (norm && norm !== raw) {
            this._logEmotion(`setRoundEmotion(${raw}) → 规范键 ${norm}（仅记录，不参与表情决策）`);
        }
    }

    setExpressionOnly(emotion, holdMs = 3200) {
        this._logEmotion(`setExpressionOnly(${emotion}) 纯表情轮次 → 解锁ASR + ${holdMs}ms后回落表情`);
        if (emotion) {
            const norm = normalizeEmotionKey(emotion);
            if (norm) this.setEmotion(norm);
        }
        try {
            if (this.onExpressionOnlyCallback) {
                this.onExpressionOnlyCallback();
            } else if (this.onEndCallback) {
                
                this.onEndCallback();
            }
        } catch (e) {   }
        this._exprOnlyTimer = setTimeout(() => {
            this._exprOnlyTimer = null;
            this._logEmotion('纯表情轮次：表情停留结束，回落');
            try {
                if (this.onExpressionRelaxCallback) {
                    this.onExpressionRelaxCallback();
                } else if (this.onEndCallback) {
                    this.onEndCallback();
                }
            } catch (e) {   }
        }, holdMs);
    }

    _enqueueSegment(segment) {
        if (!segment || !segment.trim()) return;
        segment = String(segment)
            .replace(/\(think\)/gi, '')
            .replace(/^\s*[A-Z][ \t]{2,}(?=[A-Z])/, '')
            .trim();
        if (!segment || /^[A-Z]$/.test(segment)) return;
        if (this._staleSegmentGuard && this._staleSegmentGuard(this._currentTurn)) return;
        const _raw = String(segment).trim();
        if (_raw.length <= 3) {
            if (this.textSegmentQueue && this.textSegmentQueue.length > 0) {
                const last = this.textSegmentQueue[this.textSegmentQueue.length - 1];
                if (last && last.text !== undefined) {
                    last.text = (String(last.text).trimEnd() + ' ' + _raw).trim();
                    return;
                }
            }
            if (this.pendingSegment && this.pendingSegment.length
                && !this.textSegmentQueue) {
            }
        }
        if (this._sentIdxTurn !== this._currentTurn) {
            this._sentIdxTurn = this._currentTurn;
            this._sentIdx = 0;
            this._aiEmotionSeq = null;
        }
        const local = EmotionClassifier.classify(segment);
        const sentIdx = this._sentIdx;
        this._sentIdx += (String(segment).match(/[.!?。！？]+/g) || []).length;
        const aiSeq = this._aiEmotionSeq;
        const aiKey = (aiSeq && aiSeq.length)
            ? aiSeq[Math.min(sentIdx, aiSeq.length - 1)] : null;
        const emotion = local.strong ? local.key : (aiKey || local.key);
        let seg = segment.replace(/\s+([.,!?;:])/g, '$1');
        if (!seg.trim()) return;
        const _tail = this.textSegmentQueue[this.textSegmentQueue.length - 1];
        if (_tail && _tail.text === seg) return;
        if (this._pgText.length && (this._pgText.length + seg.length) > this._pgMax) {
            this._pgIdx += 1;
            this._pgText = '';
        }
        const _pageBase = this._pgText;
        this._pgText += seg;
        this._pgTotal = this._pgIdx + 1;
        this.textSegmentQueue.push({ text: seg, emotion, pageIdx: this._pgIdx,
            pageBase: _pageBase, turn: this._currentTurn,
            sentIdx, strong: local.strong, localEmotion: local.key });
    }

    setAiEmotionSequence(arr) {
        if (!Array.isArray(arr) || !arr.length) return;
        this._aiEmotionSeq = arr;
        let changed = 0;
        for (const it of this.textSegmentQueue) {
            if (!it || it.strong !== false) continue;
            const k = arr[Math.min(it.sentIdx, arr.length - 1)];
            if (k && k !== it.emotion) { it.emotion = k; changed += 1; }
        }
        this._logEmotion(`AI 逐句情绪到齐 ${arr.length} 项，覆盖低置信度段 ${changed} 个`);
    }

    _smartSplit(text, limit = this.maxSegmentChars) {
        const out = [];
        let start = 0;

        while (start < text.length) {
            
            const HARD_SPLIT_CHARS = this._hardSplitChars
                || (this._hardSplitChars = _cfgHardSplitChars(this.config));
            if (text.length - start <= HARD_SPLIT_CHARS) break;

            const searchEnd = Math.min(text.length, start + limit + 30);
            let cut = -1;
            for (let k = start; k < searchEnd; k++) {
                const ch = text.charAt(k);
                if (!SENTENCE_END_CHARS.includes(ch)) continue;
                if (ch === '.' && /\d/.test(text.charAt(k + 1))) continue;
                let j = k;
                while (j + 1 < searchEnd && SENTENCE_END_CHARS.includes(text.charAt(j + 1))) j++;
                cut = j + 1;
                k = j;
            }
            if (cut > 0 && text.length - cut < 12) {
                cut = -1;
            }
            if (cut < 0) {
                const wideEnd = Math.min(text.length, start + HARD_SPLIT_CHARS);
                cut = findSentenceEnd(text.slice(0, wideEnd), start);
                if (cut > 0 && text.length - cut < 12) cut = -1;
            }
            if (cut < 0) {
                for (let k = start + HARD_SPLIT_CHARS; k > start + 5 && k > start + limit; k--) {
                    if (/\s/.test(text.charAt(k - 1))) { cut = k; break; }
                }
                if (cut < 0) cut = Math.min(text.length, start + HARD_SPLIT_CHARS);
            }

            const seg = text.slice(start, cut)
                
                .replace(/\s+([.,!?;:])/g, '$1');
            if (seg.trim()) out.push(seg);
            start = cut;
        }

        const tail = text.slice(start).replace(/\s+([.,!?;:])/g, '$1');
        if (tail.trim()) out.push(tail);
        return out;
    }

    _joinSegments(segs) {
        const out = [];
        for (let i = 0; i < segs.length; i++) {
            let s = segs[i];
            if (i === 0) { out.push(s); continue; }

            const prev = out[out.length - 1];
            if (/[A-Za-z0-9]$/.test(prev) && /^[A-Za-z0-9]/.test(s)) {
                out.push(' ' + s);
                continue;
            }
            if (/^[.,!?;:]/.test(s)) {
                if (/\s$/.test(prev)) {
                    out.push(s);
                } else {
                    out.push(' ' + s);
                }
                continue;
            }
            out.push(s);
        }
        return out;
    }

    _wordSafeCut(buf, limit) {
        for (let k = limit; k > limit - 25 && k > 5; k--) {
            if (/\s/.test(buf[k - 1])) return k;
        }
        return limit;
    }

    setEmotion(name) {
        if (!name) return;
        this.currentEmotion = String(name).toLowerCase();
        this._logEmotion(`setEmotion(${this.currentEmotion}) `
            + `callback=${this.onEmotionCallback ? '已挂上' : '★没挂上'}`);
        if (this.onEmotionCallback) {
            try {
                this.onEmotionCallback(this.currentEmotion);
            } catch (e) {
                this._logEmotion(`  ★ onEmotionCallback 抛错: ${e && e.message}`);
            }
        }
    }

    _logEmotion(msg) {
        const line = `[${new Date().toISOString()}] ${msg}`;
        try {
            const fs = require('fs');
            const p = require('path');
            const dir = p.join(__dirname, '..', 'logs');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.appendFileSync(p.join(dir, 'emotion.log'), line + '\n');
        } catch (e) {   }
    }

    addStreamingText(text, turn) {
        if (this.shouldStop) return;
        if (!text) return;
        if (turn !== undefined && turn !== null && turn !== this._currentTurn) {
            this._staleChunks = (this._staleChunks || 0) + 1;
            return;
        }

        this._sentenceBuf += String(text);
        try {
            this._drainSentences(false);
        } catch (e) {
            try {
                console.error('[TTS] _drainSentences 异常（文本已保留，等待下一 chunk 重试）:', e);
                this._logEmotion(`[TTS切分异常] ${e && e.message || e} | buf="${this._sentenceBuf.slice(-60)}"`);
            } catch (e2) {   }
        }
    }

    _stripCppMarkers(text) {
        if (!text) return '';
        let out = String(text);
        out = out.replace(/(?:\[{0,2}|)(?:P_|CPP_)BEGIN(?:\]{0,2}|)[^\n]{0,4000}?(?:P_|CPP_)END(?:\]{0,2}|)(?!\w)/gi, '');
        out = out.replace(/(?:\[{0,2}|)(?:P_|CPP_)BEGIN(?:\]{0,2}|)[^\n]*/gi, '');
        out = out.replace(/(?:\[{0,2}|)(?:P_|CPP_)END(?:\]{0,2}|)[^\n]*/gi, '');
        out = out.replace(/\[{0,2}CPP_(?:BEGIN|END)\]{0,2}/gi, '');
        out = out.replace(/(?:P_?|_)?(?:BEGIN|END)\]{1,2}/gi, '');
        out = out.replace(/(?:P_|CPP_)(?:BEGIN|END)(?!\w)/gi, '');
        out = out.replace(/\[\[CPP_(?:BEG(?:IN)?|E(?:ND)?|BE(?:GIN)?|B)\]{0,2}/gi, '');
        out = out.replace(/(?:P_|CPP_)(?:B|E)(?![A-Za-z])[\]]{0,2}[^\n]*/gi, '');
        out = out.replace(/\[{1,2}\s*\]{1,2}/g, '');
        out = out.replace(/\s{2,}/g, ' ');
        out = out.replace(/\s+([,;:.!?])/g, '$1');
        return out.trim();
    }

    _looksLikeCode(t) {
        const s = String(t || '');
        if (!s) return false;
        const STRONG = [
            /#\s*include/i,
            /#\s*define/i, /#\s*ifndef/i, /#\s*ifdef/i, /#\s*pragma/i,
            /int\s+main\s*\(/i,
            /void\s+main/i,
            /std\s*::\s*\w+/i,
            /using\s+namespace/i,
            /cout\s*<</i, /cin\s*>>/i,
            /printf\s*\(/i,
            /(?:void|int|double|float|char|bool|auto|long|unsigned|string)\s+[A-Za-z_]\w*\s*\([^)]*\)\s*\{/i,
            /\b(?:for|while|if|else|switch)\s*\([^)]*\)\s*\{/i,
            /\bdef\s+[A-Za-z_]\w*\s*\([^)]*\)\s*:/i,
            /\bimport\s+(?:os|sys|numpy|pandas|torch|re|json|math|random|time|requests|flask)\b/i,
            /^\s*from\s+[\w.]+\s+import\s+/i,
            /\bprint\s*\(/i,
            /\b(?:console\.log|console\.error|console\.warn)\s*\(/i,
            /\b(?:const|let|var)\s+\w+\s*=\s*(?:function|=>|require\s*\(|new\s+)/i,
            /=>\s*\{/i,
            /\b(?:npm\s+(?:install|run|init|start|build)|pip\s+install|git\s+(?:clone|commit|push|pull|add)|curl\s+-|wget\s+-|chmod\s+\+|chown\s+)\b/i, 
            /#!\/bin\/(?:ba)?sh/i,
            /\bfunc\s+\w+\s*\([^)]*\)\s*[A-Za-z0-9_.\[\]]*\s*\{/i,
            /\bpackage\s+main\b/i,
            /\b(?:println|fmt\.Printf)\s*\(/i,
            /\b(?:GetStdHandle|SetConsoleCursorPosition|SetConsoleTextAttribute|SetConsoleCursorInfo|SetConsoleMode|GetConsoleScreenBufferInfo|ReadConsole|WriteConsole|GetAsyncKeyState|GetCursorPos|SetCursorPos|Sleep)\s*\(/i,
            /\b(?:HANDLE|COORD|DWORD|WORD|LPDWORD|CONSOLE_SCREEN_BUFFER_INFO|SMALL_RECT|HINSTANCE|HWND)\s+\w+\s*[=;]/i,
            /\b(?:BOOL|TRUE|FALSE)\s+\w+\s*=\s*(?:TRUE|FALSE|0|1)\s*;/i,
            /\(\s*(?:int|char|short|long|float|double|void|SHORT|LONG|DWORD|WORD|BYTE|UINT|POINT|COORD)\s*\*?\s*\)\s*[\(\w]/i,
            /\b(?:SHORT|USHORT|POINT|LONG|ULONG|UINT|BYTE|LPARAM|WPARAM|HDC|HBRUSH|HPEN|HMENU|LPSTR|LPCSTR|LPVOID|DWORD_PTR|UINT_PTR)\s+\w+\s*[=;,]/,
            /\w+\s*->\s*\w+/i,
            /\b[A-Za-z_]\w*\s*\.[xywh]\s*=/i,
        ];
        for (const r of STRONG) if (r.test(s)) return true;
        let score = 0;
        const WEAK = [
            /\breturn\s+0\s*;/i,
            /\bclass\s+\w+\s*\{/i,
            /<\s*iostream\s*>/i,
            /\{\s*\}/,
            /\b(?:elif|elif\s+.*:|else\s*:)\b/i,
            /\b(?:self|cls)\s*[,)]/i,              
            /\b(?:lambda|yield|async|await)\b/i,
        ];
        for (const r of WEAK) if (r.test(s)) score += 40;
        const braces = (s.match(/[{}]/g) || []).length;
        if (braces >= 2) score += 30;
        const semis = (s.match(/;/g) || []).length;
        if (semis >= 2) score += 20;
        const lines = s.split(/\r?\n/).filter(l => l.trim());
        const codeish = lines.filter(l => /[{};]/.test(l)).length;
        if (lines.length >= 2 && codeish >= 2) score += 40;
        return score >= 60;
    }

    _cleanSentencePiece(piece) {
        let t = String(piece);
        
        const open = this._matchOpenTagTail(t);
        if (open) t = t.slice(0, t.length - open.length);
        t = EnhancedTextProcessor.stripEmotionTags(t);
        t = stripEmoji(t);
        t = this._stripCppMarkers(t);
        if (this._looksLikeCode(t)) return '';
        
        t = t.replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, '');
        t = t.replace(/\s+([.,!?;:])/g, '$1');
        t = t.replace(/[ \t]{2,}/g, ' ');
        return t;
    }

    _flushPiece(piece) {
        const t = this._cleanSentencePiece(piece);
        if (!t.trim()) return;
        if (this._looksLikeMetaInstruction(t)) {
            this._metaDropCount = (this._metaDropCount || 0) + 1;
            try {
                this._logEmotion(`[TTS指令泄漏] 已丢弃元指令段 #${this._metaDropCount}: "${t.slice(0, 80)}"`);
            } catch (e) {   }
            return;
        }
        this.llmFullResponse += t;
        for (const seg of this._smartSplit(t)) {
            this._enqueueSegment(seg);
        }
    }

    _looksLikeMetaInstruction(t) {
        const s = String(t || '').toLowerCase();
        if (!s) return false;
        const MARKERS = [
            'his words did not change what you were saying',
            'his words did change the direction',
            'you were interrupted while speaking',
            'user interrupted you mid-reply',
            'interruption context',
            'interruption rule',
            'you are marked as interrupted',
            'in this case finish the sentence/thought',
            'in this case drop the unfinished line',
            'do not repeat what user already heard',
            'what user already heard (tail of your previous reply)',
            'the part user did not hear',
            'old content. never quote, repeat or paraphrase',
            'this is a running summary of where you and user are right now',
            'you may use it to stay continuous - do not recite it back',
            'humanity level',
            'be fully human-like and in-character',
            'user only made a brief sound',
            'he was just reacting, agreeing, adding a small detail',
            'or making a brief sound. this is case (a)',
            'continue the sentence/thought you were cut off in',
        ];
        for (const m of MARKERS) {
            if (s.includes(m)) return true;
        }
        if (/^\([ab]\)\s+/.test(s) && s.length >= 40) return true;
        if (/^[ab]:\s+/i.test(s) && s.length >= 40) return true;
        if (/^【/.test(t) && /(INTERRUPT|中断|打断)/i.test(t)) return true;
        if (/^【/.test(t) && /[a-z]{4,}\s+(the|your|you|user)/i.test(s) && s.length >= 40) return true;
        return false;
    }

    _tagSafeCut(s, cut) {
        let guard = 0;
        while (cut > 0 && guard++ < 3) {
            const open = this._matchOpenTagTail(s.slice(0, cut));
            if (!open) break;
            const idx = s.slice(0, cut).lastIndexOf(open[0]);
            if (idx <= 0) return 0;
            cut = idx;
        }
        return cut;
    }

    _drainSentences(force) {
        let s = this._sentenceBuf || '';
        if (!s) return;

        if (force) {
            this._sentenceBuf = '';
            if (s.trim()) {
                this._flushPiece(s);
                this._fastFirstSegDone = true;
            }
            return;
        }

        while (s) {
            
            const cut0 = findSentenceEnd(s, 0);
            let cut = cut0;

            if (cut < 0 && s.length >= HARD_SEGMENT_CHARS) {
                for (let k = s.length - 1; k >= Math.floor(s.length * 0.5); k--) {
                    if (/\s/.test(s.charAt(k - 1))) { cut = k; break; }
                }
                if (cut <= 0) cut = Math.floor(s.length * 0.5);
            }

            if (cut <= 0) break;

            
            cut = this._tagSafeCut(s, cut);
            if (cut <= 0) break;

            const piece = s.slice(0, cut);
            s = s.slice(cut);
            if (piece.trim()) {
                this._flushPiece(piece);
                this._fastFirstSegDone = true;
            }
        }
        this._sentenceBuf = s;
    }

    _matchOpenTagTail(buf) {
        const m = String(buf).match(EMO_OPEN_TAIL);
        if (!m) return '';
        const tail = m[0];
        if (tail.indexOf(']') >= 0 || tail.indexOf('】') >= 0) return '';
        return tail;
    }

    _matchTrailingPunct(buf) {
        const m = String(buf).match(/[,;:]\s*$/);
        return m ? m[0] : '';
    }

    _matchOpenWordTail(buf) {
        const s = String(buf);
        const m = s.match(/[A-Za-z]{1,20}$/);
        if (!m) return '';
        const tail = m[0];
        const before = s.slice(0, s.length - tail.length);
        if (/[.?!,;:]\s*$/.test(before)) return '';
        
        if (tail.length >= 20) return '';
        return tail;
    }

_flushWordHold() {
        if (!this._wordHold) return;
        const tail = this._wordHold;
        this._wordHold = '';
        this._wordHoldAt = 0;
        if (!tail.trim()) return;
        this.llmFullResponse += tail;
        this._sentenceBuf += tail;
        this._drainSentences(false);
    }

    finalizeStreamingText() {
        if (this._sentenceBuf) {
            const rest = this._sentenceBuf;
            this._sentenceBuf = '';
            if (rest.trim()) {
                this._flushPiece(rest);
                this._fastFirstSegDone = true;
            }
        }
        if (this.pendingSegment.trim()) {
            this._enqueueSegment(this.pendingSegment);
            this.pendingSegment = '';
        }
    }

    
    async processTextToSpeech(text) {
        if (!text.trim()) return;

        text = stripEmoji(String(text));
        text = EnhancedTextProcessor.stripEmotionTags(text);
        if (!text.trim()) return;

        this.reset();
        this.llmFullResponse = text;

        for (const seg of this._smartSplit(text)) {
            this._enqueueSegment(seg);
        }
    }

    stopAudioOnly() {
        this._segToken = (this._segToken || 0) + 1;
        this._fillGen = (this._fillGen || 0) + 1;
        if (this._subRAF) {
            try { cancelAnimationFrame(this._subRAF); } catch (e) {   }
            this._subRAF = null;
        }
        if (this._fillRAF) {
            try { cancelAnimationFrame(this._fillRAF); } catch (e) {   }
            this._fillRAF = null;
        }
        if (this._subSyncRAF) {
            try { cancelAnimationFrame(this._subSyncRAF); } catch (e) {   }
            this._subSyncRAF = null;
        }

        
        this._ttsEpoch = (this._ttsEpoch || 0) + 1;
        this._nextSeqToPush = this._ttsSeq || 0;
        this._pendingAudios = new Map();
        this._synthInFlight = 0;

        this.textSegmentQueue = [];
        this.audioDataQueue = [];
        this.syncTextQueue = [];
        this.pendingSegment = '';
        this._sentenceBuf = '';
        this._tagHold = '';
        this._wordHold = '';
        this._wordHoldAt = 0;
        this._punctHold = '';

        if (this.currentAudio) {
            try {
                this.currentAudio.pause();
                if (typeof Event === 'function') {
                    this.currentAudio.dispatchEvent(new Event('ended'));
                }
            } catch (e) {   }
            this.currentAudio = null;
        }
        this._audioPlaying = false;
        this.isProcessing = false;
        if (this.onAudioDataCallback) {
            try { this.onAudioDataCallback(0); } catch (e) {   }
        }

    }

    reset() {
        this.llmFullResponse = '';
        this.displayedText = '';
        this._liveSubtitleText = '';   
        this.currentSegmentText = '';
        this._curSegRatePct = '-15%';
        this.pendingSegment = '';
        this.syncTextQueue = [];
        this._spokenOffset = 0;
        this._spokenText = '';
        this._completedSegments = [];
        this._curSegTotal = 0;
        this._curSegRevealed = 0;
        
        this._tagHold = '';
        this._wordHold = '';
        this._wordHoldAt = 0;
        this._fastFirstSegDone = false;
        this._punctHold = '';
        
        this._sentenceBuf = '';
        
        this._roundEmotion = null;

        if (this._subRAF) { cancelAnimationFrame(this._subRAF); this._subRAF = null; }
        this._segToken = (this._segToken || 0) + 1;
        if (this._fillRAF) { cancelAnimationFrame(this._fillRAF); this._fillRAF = null; }
        this._fillGen = (this._fillGen || 0) + 1;
        if (this._subSyncRAF) { cancelAnimationFrame(this._subSyncRAF); this._subSyncRAF = null; }

        
        this.textSegmentQueue = [];
        this.audioDataQueue = [];
        this._ttsEpoch = (this._ttsEpoch || 0) + 1;
        this._currentTurn = (this._currentTurn || 0) + 1;
        this._staleChunks = 0;
        this._pgIdx = 0;
        this._pgText = '';
        this._pgTotal = 1;
        this._curPage = null;
        try { if (typeof global.updateSubtitlePage === 'function') global.updateSubtitlePage(0, 0); } catch (e) {   }
        this._nextSeqToPush = this._ttsSeq;
        this._pendingAudios = new Map();

        if (this.currentAudio) {
            try {
                this.currentAudio.pause();
                this.currentAudio.dispatchEvent(new Event('ended'));
            } catch (e) {   }
            this.currentAudio = null;
        }

        this._audioPlaying = false;
        this.isProcessing = false;
        this.shouldStop = false;
        this._endFired = false;
        this.currentEmotion = null;
        if (this._exprOnlyTimer) {
            clearTimeout(this._exprOnlyTimer);
            this._exprOnlyTimer = null;
        }

        if (this.onAudioDataCallback) {
            this.onAudioDataCallback(0);
        }
    }

    getInterruptBoundary() {
        const full = this.llmFullResponse || '';
        let offset = this._spokenOffset || 0;
        const seg = this.currentSegmentText || '';
        const audio = this.currentAudio;
        let frac = 0;
        const _dur = audio ? this._timelineDur(audio, seg).dur : 0;
        if (audio && seg && _dur > 0 && audio.currentTime > 0) {
            frac = Math.min(1, Math.max(0, audio.currentTime / _dur));
        } else if (this._curSegTotal > 0) {
            frac = Math.min(1, Math.max(0, (this._curSegRevealed || 0) / this._curSegTotal));
        }
        const partialLen = Math.round((seg.length || 0) * frac);
        offset = Math.min(offset + partialLen, full.length);
        const heard = full.slice(0, offset);
        const missed = full.slice(offset);
        return { full, heard, missed, offset, frac,
                 spokenText: this._spokenText || '' };
    }

    startTurn(turnId) {
        this._currentTurn = (turnId !== undefined) ? turnId : (this._currentTurn + 1);
        return this._currentTurn;
    }

    
    discardStaleTurns(maxTurn) {
        const keep = (it) => (it && (it.turn === undefined || it.turn >= maxTurn));
        const before = this.audioDataQueue.length;
        this.audioDataQueue = this.audioDataQueue.filter(keep);
        const droppedQueue = before - this.audioDataQueue.length;
        if (this._pendingAudios) {
            for (const k of Array.from(this._pendingAudios.keys())) {
                const it = this._pendingAudios.get(k);
                if (!keep(it)) this._pendingAudios.delete(k);
            }
            if (this._pendingAudios.size === 0) {
                this._nextSeqToPush = this._ttsSeq;
            } else {
                const _minKey = Math.min(...Array.from(this._pendingAudios.keys()));
                if (_minKey > this._nextSeqToPush) this._nextSeqToPush = _minKey;
            }
        }
        if (this.currentAudio && this.currentTurn < maxTurn) {
            try {
                if (this.currentAudio.pause) this.currentAudio.pause();
                this.currentAudio.currentTime = 0;
            } catch (e) {   }
        }
        return droppedQueue;
    }

    getBoundaryState() {
        const completed = this._completedSegments || [];
        const curSeg = this.currentSegmentText || '';
        const total = this._curSegTotal || 0;
        const revealed = this._curSegRevealed || 0;
        let partial = '';
        if (curSeg && total > 0) {
            const frac = Math.min(1, Math.max(0, revealed / total));
            partial = curSeg.slice(0, Math.round(curSeg.length * frac));
        }
        const curRemain = curSeg ? curSeg.slice(partial.length) : '';
        const queued = (this.audioDataQueue || []).map(it => it.text || '');
        const pending = (this.textSegmentQueue || []).map(it => it.text || '');
        const unplayed = queued.concat(pending).join(' ')
            + (curRemain ? ' ' + curRemain : '');
        return {
            completedSegments: completed.slice(),
            completedText: completed.join(' '),
            currentSegment: curSeg,
            currentPartial: partial,
            currentRevealed: revealed,
            currentTotal: total,
            unplayedText: unplayed.trim(),
        };
    }

    _fireEnd() {
        this._lastSpeakEndAt = Date.now();
        if (this._endFired) return;
        this._endFired = true;
        if (this._endGuard) { clearTimeout(this._endGuard); this._endGuard = null; }
        if (this.onEndCallback) {
            try { this.onEndCallback(); } catch (e) { console.warn('onEnd 回调出错', e); }
        }
    }

    stop() {
        this.shouldStop = true;
        this.reset();

        if (typeof hideSubtitle === 'function') {
            hideSubtitle();
        }

        this._fireEnd();
    }

    duckVolume(scale) {
        this._targetVolume = scale;
        if (scale > 0) {
            this._muteIntentAt = 0;
        } else if (!this._muteIntentAt) {
            this._muteIntentAt = Date.now();
        }
        if (this.currentAudio && typeof this.currentAudio.volume === 'number') {
            try { this.currentAudio.volume = scale; } catch (e) {   }
        }
    }

    _healStuckMuteVolume() {
        const v = this._targetVolume;
        if (v === undefined || v >= 1) return;
        const intentAt = this._muteIntentAt || 0;
        if (!intentAt) return;
        const age = Date.now() - intentAt;
        if (age < TTS_MUTE_INTENT_TTL_MS) return;
        this._targetVolume = 1.0;
        this._muteIntentAt = 0;
        try {
            if (this.currentAudio && typeof this.currentAudio.volume === 'number') {
                this.currentAudio.volume = 1.0;
            }
        } catch (e) {   }
        if (typeof global.__neuroTtsDiag === 'function') {
            try { global.__neuroTtsDiag('音量自愈：静音意图已过期 ' + age + 'ms，恢复为 1.0'); } catch (e) {}
        }
    }

    syntheticMouthValue(tSec) {
        
        const t = (typeof tSec === 'number' && isFinite(tSec))
            ? tSec
            : ((typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000);
        const base = (Math.sin(t * 2 * Math.PI * 4.2) + 1) / 2;
        const jitter = 0.12 * Math.sin(t * 2 * Math.PI * 13);
        const breath = 0.86 + 0.14 * Math.sin(t * 2 * Math.PI * 0.35);
        let v = (0.18 + 0.62 * base + jitter) * breath;
        return Math.max(0, Math.min(1, v));
    }

    _trimSubtitle(text) {
        let s = String(text || '');
        if (!s) return '';
        const lastCh = s.charAt(s.length - 1);
        if (s.length >= 2) {
            const body = s.slice(0, -1);
            const next = s.slice(-1);
            if (/\s/.test(next)) return s;
            if (/[A-Za-z0-9]$/.test(lastCh) && /[A-Za-z0-9]/.test(next)) {
                return s.slice(0, -1) + ' ' + next;
            }
        }
        return s;
    }

    _joinSubtitle(base, next) {
        const b = String(base || '');
        const n = String(next || '');
        return this._joinSubtitleInner(b, n);
    }

    _joinSubtitleInner(b, n) {
        if (!b) return n.replace(/^\s+/, '');
        if (!n) return b;
        const lastCh = b.charAt(b.length - 1);
        if (/\s$/.test(b)) {
            if (/^[A-Za-z0-9]/.test(n)) return b.replace(/\s+$/, '') + ' ' + n;
            return b + n;
        }
        const _stripLead = n.replace(/^\s+/, '');
        if (/^[.,!?;:]/.test(_stripLead)) {
            return b + _stripLead;
        }
        if (/^\s/.test(n)) {
            const _n = _stripLead;
            if (/[A-Za-z0-9]$/.test(lastCh) || /[.,!?;:)]$/.test(lastCh)) {
                return b + ' ' + _n;
            }
            return b + _n;
        }
        if (/[.,!?;:]/.test(lastCh) && /^[A-Za-z0-9]/.test(n)) {
            return b + ' ' + n;
        }
        if (/[A-Za-z0-9]$/.test(lastCh) && /^[A-Za-z0-9]/.test(n)) {
            return b + ' ' + n;
        }
        return b + n;
    }

    _revealUnits(text) {
        const units = [];
        for (const ch of text) {
            units.push({ text: ch });
        }
        return units;
    }

    isPlaying() {
        return !!(this._audioPlaying
            || this.isProcessing
            || (this._synthInFlight || 0) > 0
            || (this._pendingAudios && this._pendingAudios.size > 0)
            || this.textSegmentQueue.length > 0
            || this.audioDataQueue.length > 0
            || (this.pendingSegment && this.pendingSegment.trim() !== ''));
    }

    
    getRecentSpokenTexts(n = 3) {
        const arr = (this._spokenLog || [])
            .map((e) => (typeof e === 'string' ? e : e.text))
            .filter(Boolean);
        return arr.slice(Math.max(0, arr.length - n));
    }

    getRecentSpokenHistory(maxAgeMs = 60000) {
        const now = Date.now();
        const arr = (this._spokenLog || [])
            .map((e) => (typeof e === 'string' ? { text: e, at: now } : e))
            .filter((e) => e && e.text && (now - (e.at || now)) <= maxAgeMs)
            .map((e) => e.text);
        
        return arr;
    }

    getLastSpeakEndAt() {
        return this._lastSpeakEndAt || 0;
    }
}

module.exports = {
    EnhancedTextProcessor,
    stripEmoji,
    __test: { EMO_TAG_RE, EMO_OPEN_TAIL, WORD_HOLD_MAX_MS,
              SUBTITLE_MIN_UNIT_MS, HARD_SEGMENT_CHARS, HARD_SPLIT_CHARS: HARD_SPLIT_CHARS_DEFAULT }
};
