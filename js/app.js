

const { EnhancedTextProcessor } = require('./js/tts-processor.js');
const { ModelInteractionController, RISE_DURATION } = require('./js/model-interaction.js');
const { VoiceChatInterface } = require('./js/voice-chat.js');
const { configLoader } = require('./js/config-loader.js');
const { CuteSoundPlayer } = require('./js/cute-sounds.js');
const { SoundBridge } = require('./js/sound-bridge.js');

const config = configLoader.load();

const cuteSounds = new CuteSoundPlayer(
    (config.ui && config.ui.cute_sounds) || {});
const soundBridge = new SoundBridge();

let subtitleTimeout = null;

let lastInteraction = Date.now();
let proactiveTimer = null;
const PROACTIVE_MIN = 240000;
const PROACTIVE_VAR = 240000;
function resetIdle() { lastInteraction = Date.now(); }
global.__neuroResetIdle = resetIdle;
function idleMs() { return Date.now() - lastInteraction; }

let idleSuspendTimer = null;
const IDLE_SUSPEND_MS = 300000;
function scheduleIdleSuspend() {
    if (idleSuspendTimer) clearTimeout(idleSuspendTimer);
    idleSuspendTimer = setTimeout(() => {
        if (_textPriority) return;
        const asr = voiceChat && voiceChat.asrProcessor;
        if (!asr) return;
        if (asr.isRecording || asr.asrLocked || asr._mergeBuf) return;
        if (ttsProcessor.isPlaying && ttsProcessor.isPlaying()) return;
        asr.suspendMic();
    }, IDLE_SUSPEND_MS);
}

async function fetchLine(hint, sysExtra, memoryMode) {
    try {
        let sys = (config.llm.system_prompt || '');
        if (sysExtra) {
            sys += '\n\n' + sysExtra;
        }
        const resp = await fetch(`${config.llm.api_url}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.llm.api_key}`
            },
            body: JSON.stringify({
                model: config.llm.model,
                stream: false,
                neuro_memory_mode: memoryMode || 'chat',
                messages: [
                    { role: 'system', content: sys },
                    { role: 'user', content: hint }
                ]
            })
        });
        const data = await resp.json();
        let line = (data.choices && data.choices[0] && data.choices[0].message.content || '').trim();
        line = line.replace(/[（(].*?[)）]/g, '').replace(/\*/g, '').replace(/^["'“”]+|["'“”]+$/g, '').trim();
        return line || null;
    } catch (e) {
        console.error('生成台词失败:', e);
        return null;
    }
}

let _lastSpeechAt = 0;
const _SPEECH_QUIET_MS = 10000;

function speak(line) {
    _lastSpeechAt = Date.now();
    ttsProcessor.processTextToSpeech(line);
}

let _visionSpeakWs = null;
let _visionSpeakBackoff = 1000;
let _visionSpeakTimer = null;

function startVisionSpeakSubscription() {
    const url = 'ws://127.0.0.1:6006/v1/vision_speak';

    const connect = () => {
        try {
            if (_visionSpeakWs && (_visionSpeakWs.readyState === 0 || _visionSpeakWs.readyState === 1)) return;
            const ws = new WebSocket(url);
            _visionSpeakWs = ws;
            ws.onopen = () => {
                _visionSpeakBackoff = 1000;
                console.log('[vision] 台词通道已连接');
                _visionSpeakReportTtsState();
            };
            const _visionSpeakReportTtsState = (playing) => {
                try {
                    
                    const _p = typeof playing === 'boolean' ? playing
                        : !!(ttsProcessor.isPlaying && ttsProcessor.isPlaying());
                    if (!_visionSpeakWs || _visionSpeakWs.readyState !== 1) return;
                    _visionSpeakWs.send(JSON.stringify({
                        type: 'tts_state',
                        playing: _p,
                        lastEndAt: (ttsProcessor.getLastSpeakEndAt && ttsProcessor.getLastSpeakEndAt()) || 0,
                    }));
                } catch (e) {   }
            };
            global.__neuroReportTtsState = _visionSpeakReportTtsState;
            ws.onmessage = (ev) => {
                try {
                    const obj = JSON.parse(ev.data);
                    if (obj.type !== 'vision_speak') return;
                    const line = String(obj.text || '').trim();
                    if (!line) return;
                    window.__neuroVisionActive = Date.now() + 3000;
                    const playing = !!(ttsProcessor.isPlaying && ttsProcessor.isPlaying());
                    const generating = !!(voiceChat && voiceChat._abortController);
                    const inQuiet = (_lastSpeechAt && (Date.now() - _lastSpeechAt) < _SPEECH_QUIET_MS);
                    const ttsEndAt = (ttsProcessor.getLastSpeakEndAt && ttsProcessor.getLastSpeakEndAt()) || 0;
                    const justSpoke = (ttsEndAt && (Date.now() - ttsEndAt) < 8000);
                    const _interruptQuiet = (typeof global.__neuroLastInterruptAt === 'number'
                        && (Date.now() - global.__neuroLastInterruptAt) < 6000);
                    const _visionQuiet = (typeof global.__neuroVisionQuietUntil === 'number'
                        && Date.now() < global.__neuroVisionQuietUntil);
                    if (playing || generating || inQuiet || justSpoke || _interruptQuiet || _visionQuiet) {
                        console.log('[vision] 她正忙/刚说完/刚被打断/对话进行中，丢弃一条视觉台词');
                        return;
                    }
                    speak(line);
                    resetIdle();
                } catch (e) {   }
            };
            ws.onerror = () => {   };
            ws.onclose = () => {
                _visionSpeakWs = null;
                if (_visionSpeakTimer) clearTimeout(_visionSpeakTimer);
                _visionSpeakTimer = setTimeout(connect, _visionSpeakBackoff);
                _visionSpeakBackoff = Math.min(_visionSpeakBackoff * 2, 15000);
            };
        } catch (e) {
            if (_visionSpeakTimer) clearTimeout(_visionSpeakTimer);
            _visionSpeakTimer = setTimeout(connect, _visionSpeakBackoff);
            _visionSpeakBackoff = Math.min(_visionSpeakBackoff * 2, 15000);
        }
    };
    connect();
}

function _recordExchange(userText, assistantText) {
    if (!voiceChat || !voiceChat.messages) return;
    voiceChat.messages.push({ role: 'user', content: userText, ts: Date.now() });
    voiceChat.messages.push({ role: 'assistant', content: assistantText, ts: Date.now() });
    if (voiceChat.enableContextLimit && voiceChat.trimMessages) voiceChat.trimMessages();
}

async function greet() {
    
    const scenes = [
        '(You have just been woken up. This is the first thing you say today.)',
        '(You just woke from sleep. Dawn is breaking outside the window.)',
        '(You notice them looking at you, and feel a little shy.)',
        '(You just got a piece of code working, and feel quietly smug about it.)',
        '(You are bored and restless, looking for something to play with.)',
        '(You just woke up from a strange dream.)',
        '(An amusing idea just hit you and you cannot wait to share it.)',
    ];
    const scene = scenes[Math.floor(Math.random() * scenes.length)];
    const _uLabel = (voiceChat && voiceChat._userLabel) || 'user';
    const sysExtra = 'This is your first line after being woken up. '
        + 'Open the conversation as Neuro - in character, warm and a little playful, '
        + `exactly how you are with ${_uLabel}. `
        + 'Say ONE line only, in English. No quotes, no brackets, no explanation, no greeting-card clichés.';
    let line = await fetchLine(scene, sysExtra, 'opening');
    if (!line) {
        await new Promise((r) => setTimeout(r, 1200));
        line = await fetchLine(scene, sysExtra, 'opening');
    }
    if (line) {
        _recordExchange(scene, line);
        speak(line);
    } else {
        _recordExchange(scene, INTRO_TEXT);
        speak(INTRO_TEXT);
    }
}

async function proactiveSpeak() {
    let emo = '';
    try {
        emo = (modelController && modelController.emotion)
            || (ttsProcessor && ttsProcessor._roundEmotion) || '';
    } catch (e) {   }
    let ctx = '';
    try {
        const ms = (voiceChat && voiceChat.messages || []).filter(m => m.role !== 'system');
        const last = ms.slice(-2);
        if (last.length) {
            ctx = '\n(Recent conversation: ' + last.map(m =>
                (m.role === 'user' ? 'they' : 'you') + ' said: ' + String(m.content).slice(0, 80)
            ).join('; ') + ')';
        }
    } catch (e) {   }
    const line = await fetchLine(
        `(Nobody is talking to you, but you suddenly feel like speaking.) Your current mood is [${emo || 'calm'}]. ${ctx}`,
        'You feel like speaking up on your own right now. '
        + 'Say ONE line, in English, as Neuro - follow your current mood and '
        + 'what you two were just talking about. '
        + 'Do not ask if user is there, do not end with a checking question. '
        + 'No quotes, no brackets, no explanation.',
        'proactive'
    );
    if (line) {
        _recordExchange(`(She decided to speak up on her own. Mood: ${emo || 'calm'})`, line);
        speak(line);
    }
}

function _emotionDelayFactor(emo) {
    if (!emo) return 1.0;
    const e = String(emo).toLowerCase();
    if (/excit|happy|cheer/.test(e)) return 0.5;
    if (/sad|angry/.test(e)) return 1.6;
    return 1.0;
}

function scheduleProactive() {
    try {
        const ui = (config && config.ui) || {};
        if (ui.proactive_timer !== true) {
            if (proactiveTimer) { clearTimeout(proactiveTimer); proactiveTimer = null; }
            return;
        }
    } catch (e) {   }
    if (proactiveTimer) clearTimeout(proactiveTimer);
    let emo = '';
    try { emo = (modelController && modelController.emotion) || ''; } catch (e) {   }
    const delay = (20000 + Math.pow(Math.random(), 3) * 1800000) * _emotionDelayFactor(emo);
    proactiveTimer = setTimeout(async () => {
        if (ttsProcessor && typeof ttsProcessor.isPlaying === 'function'
                && ttsProcessor.isPlaying()) {
            scheduleProactive();
            return;
        }
        
        if (_lastSpeechAt && (Date.now() - _lastSpeechAt) < _SPEECH_QUIET_MS) {
            scheduleProactive();
            return;
        }
        await proactiveSpeak();
        resetIdle();
        scheduleProactive();
    }, delay);
}

const _textBar = document.getElementById('text-input-bar');
const _textInput = document.getElementById('text-input');
const _textSend = document.getElementById('text-send');

let _textPriority = false;

function _setTextPriority(on) {
    if (_textPriority === on) return;
    _textPriority = on;
    const asr = voiceChat && voiceChat.asrProcessor;
    if (!asr) return;
    if (on) {
        asr.suspendMic(true);
        if (idleSuspendTimer) { clearTimeout(idleSuspendTimer); idleSuspendTimer = null; }
        console.log('[text] 文本优先生效 → 已挂起语音识别（打字不会再触发她）');
    } else {
        asr.resumeMic();
        scheduleIdleSuspend();
        console.log('[text] 文本优先解除 → 语音识别已恢复');
    }
}

function _textIsActive() {
    if (!_textInput) return false;
    return document.activeElement === _textInput || _textInput.value.trim().length > 0;
}

let _textBargeDone = false;

function _mindEvent(kind, amp) {
    try {
        const url = (window.__neuroBackendBase || 'http://127.0.0.1:6006') + '/v1/mind/event';
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: kind, amp: amp || 0.5 }),
            keepalive: true,
        }).catch(function () {   });
    } catch (e) {   }
}


function _interruptHer(why) {
    if (_textBargeDone) return false;
    if (!voiceChat || !voiceChat.ttsProcessor) return false;
    if (!voiceChat.ttsProcessor.isPlaying()) return false;
    console.log(`[text] ${why} → 打断她的语音输出`);
    voiceChat.abortCurrentReply();
    voiceChat.ttsProcessor.reset();
    _textBargeDone = true;
    if (window.__stateVisual && typeof window.__stateVisual.flashInterrupt === 'function') {
        window.__stateVisual.flashInterrupt();
    }
    try { _mindEvent('interrupt', 0.8); } catch (e) {   }
    return true;
}

function _sendByText() {
    if (!_textInput) return;
    const text = _textInput.value.trim();
    if (!text) return;
    _textInput.value = '';
    if (!voiceChat || !voiceChat.sendToLLM) return;
    console.log(`[text] 发送: ${text}`);
    _interruptHer('发送前');
    voiceChat.sendToLLM(text);
}

function _toggleTextBar() {
    if (!_textBar || !_textInput) return;
    const showing = _textBar.classList.toggle('show');
    if (showing) {
        _interruptHer('调出输入框');
        try { _textInput.focus(); } catch (e) {   }
        _setTextPriority(true);
    } else {
        _textBargeDone = false;
        try { _textInput.blur(); } catch (e) {   }
        _setTextPriority(false);
    }
}

if (_textInput) {
    _textInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            _sendByText();
            try { _textInput.focus(); } catch (_) {   }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            _textInput.value = '';
            _textInput.blur();
            _textBar.classList.remove('show');
            _textBargeDone = false;
            _setTextPriority(false);
        }
        e.stopPropagation();
    });
    _textInput.addEventListener('input', () => {
        if (_textInput.value.trim().length > 0) _interruptHer('开始打字');
        _setTextPriority(_textIsActive());
    });
    _textInput.addEventListener('focus', () => _setTextPriority(true));
    _textInput.addEventListener('blur', () => {
        setTimeout(() => _setTextPriority(_textIsActive()), 80);
    });
    _textInput.addEventListener('click', (e) => e.stopPropagation());
}
if (_textSend) {
    _textSend.addEventListener('click', (e) => {
        e.stopPropagation();
        _sendByText();
    });
}

global.updateSubtitlePage = (idx, total) => {
    try {
        const box = document.getElementById('subtitle-page');
        const num = document.getElementById('subtitle-page-num');
        const dots = document.getElementById('subtitle-page-dots');
        if (!box || !num || !dots) return;
        if (!idx || !total || total <= 1) { box.style.display = 'none'; return; }
        box.style.display = 'flex';
        num.textContent = idx + ' / ' + total;
        let d = '';
        for (let i = 1; i <= total; i++) d += (i === idx ? '●' : '○') + ' ';
        dots.textContent = d.trim();
    } catch (e) {   }
};

function showSubtitle(text, duration = null) {
    const container = document.getElementById('subtitle-container');
    const subtitleText = document.getElementById('subtitle-text');

    if (!container || !subtitleText) return;

    if (subtitleTimeout) {
        clearTimeout(subtitleTimeout);
        subtitleTimeout = null;
    }

    if (typeof text === 'string') {
        text = text
            .replace(/[\[【]\s*[A-Za-z0-9_ \-\u4e00-\u9fff]{1,40}?\s*[\]】]/g, '')
            .replace(/\s+([,;:.!?，。；：！？])/g, '$1')
            .replace(/[ \t]{2,}/g, ' ')
            .trim();
    }

    subtitleText.textContent = text;
    container.style.display = 'flex';
    if (typeof text === 'string' && (text.startsWith('用户:') || text.startsWith('（'))) {
        try { global.updateSubtitlePage(0, 0); } catch (e) {   }
    }
    if (typeof text === 'string' && text.startsWith('用户:') && !_textPriority) {
        try { cuteSounds.playWelcome(idleMs()); } catch (e) {   }
        resetIdle();
        scheduleIdleSuspend();
        if (voiceChat && voiceChat.asrProcessor) {
            voiceChat.asrProcessor.resumeMic();
        }
    }

    container.scrollTop = container.scrollHeight;

    if (duration) {
        subtitleTimeout = setTimeout(() => {
            hideSubtitle();
        }, duration);
    }
}

function hideSubtitle() {
    const container = document.getElementById('subtitle-container');
    if (container) {
        container.style.display = 'none';
        container._maxW = 0;
        container._lastText = '';
        container.style.minWidth = '';
    }
    if (subtitleTimeout) {
        clearTimeout(subtitleTimeout);
        subtitleTimeout = null;
    }
}

const modelController = new ModelInteractionController(config);
let currentModel = null;
const INTRO_TEXT = 'Mmm... morning. I was having the strangest dream.';
if (!config.ui) config.ui = {};
config.ui.intro_text = INTRO_TEXT;
let voiceChat = null;

global.__neuroMouthLog = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    try { console.log(line); } catch (e) {   }
    try {
        const fs = require('fs');
        const p = require('path');
        const dir = p.join(__dirname, 'logs');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(p.join(dir, 'mouth.log'), line + '\n');
    } catch (e) {   }
};

const ttsProcessor = new EnhancedTextProcessor(
    config.tts.url,
    (value) => {
        modelController.setMouthOpenY(value);
        try {
            const _m = (window.__mouthStat = window.__mouthStat || { n: 0, max: 0, last: 0, t0: 0 });
            _m.n++; _m.last = value;
            if (value > _m.max) _m.max = value;
            if (!_m.t0) _m.t0 = Date.now();
            if (value > 0.05 && !window.__mouthLogged) {
                window.__mouthLogged = true;
                global.__neuroMouthLog('[mouth] 首个有效嘴型值 ' + value.toFixed(2)
                    + ' 模型就绪=' + !!modelController.model
                    + ' hook已装=' + !!(modelController.model && modelController.model.internalModel
                        && modelController.model.internalModel._neuroLiveHook));
            }
        } catch (e) {   }
    },
    () => {
        voiceChat && voiceChat.pauseRecording();
        try { if (typeof global.__neuroReportTtsState === 'function') global.__neuroReportTtsState(true); } catch (e) {   }
    },
    () => {
        voiceChat && voiceChat.resumeRecording();
        modelController.clearEmotion();
        try { if (typeof global.__neuroReportTtsState === 'function') global.__neuroReportTtsState(false); } catch (e) {   }
        try {
            if (typeof global !== 'undefined' && typeof global.__neuroVisionQuietUntil === 'number') {
                const _now = Date.now();
                
                if (_now < global.__neuroVisionQuietUntil) {
                    global.__neuroVisionQuietUntil = _now + 8000;
                }
            }
        } catch (e) {   }
    },
    config
);
ttsProcessor.onEmotionCallback = (name) => {
    try { soundBridge.setEmotion(name); } catch (e) {   }
    modelController.applyEmotion(name);
};

try { soundBridge.start(); } catch (e) {   }

ttsProcessor.onExpressionOnlyCallback = () => {
    voiceChat && voiceChat.resumeRecording();
};
ttsProcessor.onExpressionRelaxCallback = () => {
    modelController.clearEmotion();
};

window.modelController = modelController;
window.ttsProcessor = ttsProcessor;
window.voiceChat = voiceChat;



try {
    const _fs = require('fs');
    const _path = require('path');
    const _cfgPath = _path.join(__dirname, 'config.json');
    const _diskName = ((JSON.parse(_fs.readFileSync(_cfgPath, 'utf8')).user || {}).name || '').trim();
    if (_diskName && _diskName !== voiceChat._userLabel) voiceChat.setUserName(_diskName);
} catch (e) {   }

try {
    const { ipcRenderer: _ttsIpc } = require('electron');
    const _lastTtsProg = { seg: '', frac: -1, playing: false, speaking: false, segToken: -1, live: '' };
    setInterval(() => {
        try {
            const t = ttsProcessor;
            if (!t) return;
            
            const segToken = (typeof t._segToken === 'number') ? t._segToken : 0;
            const seg = String(t.currentSegmentText || '');
            const total = t._curSegTotal || 0;
            const revealed = t._curSegRevealed || 0;
            const frac = total > 0 ? Math.min(1, Math.max(0, revealed / total)) : 0;
            const playing = !!(t.currentAudio && !t.currentAudio.paused && !t.currentAudio.ended);
            const speaking = !!(typeof t.isPlaying === 'function' && t.isPlaying());
            
            const live = String(t._liveSubtitleText || '');
            const interrupting = (typeof global.__neuroLastInterruptAt === 'number'
                && (Date.now() - global.__neuroLastInterruptAt) < 1500);
            if (segToken === _lastTtsProg.segToken
                && seg === _lastTtsProg.seg && Math.abs(frac - _lastTtsProg.frac) < 0.02
                && live === _lastTtsProg.live
                && playing === _lastTtsProg.playing && speaking === _lastTtsProg.speaking
                && interrupting === _lastTtsProg.interrupting) return;
            _lastTtsProg.segToken = segToken;
            _lastTtsProg.seg = seg; _lastTtsProg.frac = frac; _lastTtsProg.live = live;
            _lastTtsProg.playing = playing; _lastTtsProg.speaking = speaking;
            _lastTtsProg.interrupting = interrupting;
            _ttsIpc.send('tts-progress', { seg, frac, playing, speaking, interrupting, segToken, live, ts: Date.now() });
        } catch (e) {   }
    }, 120);
} catch (e) {   }

function waitForDependencies(timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const check = () => {
            const pixiReady = typeof PIXI !== 'undefined';
            const live2dReady = !!(window.PIXI && PIXI.live2d && PIXI.live2d.Live2DModel);
            const cubismReady = typeof Live2DCubismCore !== 'undefined';
            if (pixiReady && live2dReady) return resolve(true);
            if (Date.now() - start > timeoutMs) {
                return reject(new Error(
                    '依赖加载超时（需要访问 cdn.jsdelivr.net 与 cubism.live2d.com）。' +
                    `PIXI=${pixiReady} Live2D=${live2dReady} CubismCore=${cubismReady}`
                ));
            }
            setTimeout(check, 300);
        };
        check();
    });
}


function waitForModel(model, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        if (!model) return reject(new Error('模型对象为空'));
        const start = Date.now();
        const check = () => {
            if (model.internalModel) return resolve(true);
            if (Date.now() - start > timeoutMs) {
                return reject(new Error('模型资源加载超时（2D 目录下的模型文件）'));
            }
            setTimeout(check, 200);
        };
        check();
    });
}

(async function main() {
    try {
        await waitForDependencies();

        voiceChat = new VoiceChatInterface(
            config.asr.vad_url,
            config.asr.asr_url,
            ttsProcessor,
            showSubtitle,
            hideSubtitle,
            config
        );

        voiceChat.onGateReact = (text, gate) => {
            if (ttsProcessor.isPlaying && ttsProcessor.isPlaying()) return;
            const lines = [
                '（她听见了，但不太想理你）',
                '（她瞥了你一眼，没吭声）',
                '（她哼了一声，继续忙自己的）',
                '（她装作没听见）',
            ];
            showSubtitle(lines[Math.floor(Math.random() * lines.length)], 1400);
        };

        const DPR = window.devicePixelRatio || 1;
        const RESOLUTION = Math.min(Math.max(DPR, 1), 1.5);
        const app = new PIXI.Application({
            view: document.getElementById("canvas"),
            autoStart: true,
            transparent: true,
            resolution: RESOLUTION,
            autoDensity: true,
            width: window.innerWidth,
            height: window.innerHeight
        });
        console.log(`[Live2D] resolution=${RESOLUTION} (dpr=${DPR.toFixed(2)}) `
            + `renderer=${app.renderer.width}x${app.renderer.height} `
            + `窗口=${window.innerWidth}x${window.innerHeight} `
            + `canvas CSS=${app.view.style.width}x${app.view.style.height}`);

        app.ticker.maxFPS = 24;

        app.stage.position.set(app.renderer.width / 2, app.renderer.height / 2);
        app.stage.pivot.set(app.renderer.width / 2, app.renderer.height / 2);

        console.log('[Live2D] 开始加载模型 2D/Hiyori.model3.json ...');
        const model = await PIXI.live2d.Live2DModel.from("2D/Hiyori.model3.json");
        
        await waitForModel(model, 60000);
        currentModel = model;
        app.stage.addChild(model);
        console.log('[Live2D] 模型已加载并加入舞台, internalModel =', !!model.internalModel);
        console.log('[Live2D] 画布尺寸 =', app.renderer.width, 'x', app.renderer.height,
                    '| 窗口 =', window.innerWidth, 'x', window.innerHeight,
                    '| dpr =', window.devicePixelRatio);

        modelController.init(model, app);
        modelController.setSpeakingChecker(() =>
            !!(ttsProcessor.isPlaying && ttsProcessor.isPlaying()));
        modelController.setupInitialModelProperties(config.ui.model_scale || 560);

        modelController.playEntranceAnimation();

        setTimeout(() => {
            greet();
        }, RISE_DURATION);

        const { ipcRenderer } = require('electron');

        ipcRenderer.on('toggle-text-input', () => {
            _toggleTextBar();
        });

        resetIdle();
        scheduleProactive();
        scheduleIdleSuspend();

        startVisionSpeakSubscription();

        cuteSounds.setSpeakingChecker(() =>
            !!(ttsProcessor.isPlaying && ttsProcessor.isPlaying()));
        setInterval(() => {
            try {
                const _vc = voiceChat;
                const _asr = _vc && _vc.asrProcessor;
                const _userRecent = !!(_asr && _asr._lastVoiceEndAt
                    && (Date.now() - _asr._lastVoiceEndAt) < 3000);
                const _thinking = !!(_vc && _vc._abortController);
                if (_userRecent || _thinking) return;
                const getState = () => Object.assign({
                    speaking: !!(ttsProcessor.isPlaying && ttsProcessor.isPlaying()),
                    idleMs: idleMs(),
                    timeOfDay: new Date().getHours(),
                }, soundBridge.state());
                const d = cuteSounds.tickSituation(getState);
                if (d && d.play) console.log(`[cute] ${d.key || d.sound} ← ${d.why}`);
            } catch (e) {   }
        }, 15000);

        startMicRegardlessOfModel();

    } catch (error) {
        console.error("加载模型错误:", error);
        console.error("错误详情:", error.message);
        
        try {
            showSubtitle('Failed to load: ' + error.message, 15000);
        } catch (_) {   }
        
        startMicRegardlessOfModel();
    }

    function startMicRegardlessOfModel() {
        if (window.__micBootStarted) return;
        window.__micBootStarted = true;

        if (!voiceChat || typeof voiceChat.startRecording !== 'function') {
            _logApp('voiceChat 未就绪，麦克风无法启动');
            return;
        }
        setTimeout(() => {
            Promise.resolve(voiceChat.startRecording())
                .then(() => _logApp('麦克风已启动'))
                .catch((e) => {
                    _logApp('麦克风启动失败: ' + (e && e.message));
                    try { showSubtitle('Microphone failed to start: ' + e.message, 12000); } catch (_) {}
                });
        }, 3000);
    }

    function _logApp(msg) {
        const line = `[${new Date().toISOString()}] ${msg}`;
        try {
            console.log(line);
            const fs = require('fs');
            const p = require('path');
            const dir = p.join(__dirname, 'logs');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.appendFileSync(p.join(dir, 'app_boot.log'), line + '\n');
        } catch (e) {   }
    }
})();

const _SUMMARIZED_MAX = 120;
let _summarizedSet = new Set();

function _fingerprint(msg) {
    return msg.role + '|' + String(msg.content || '').slice(0, 80);
}

function _pickFreshDialogue(dialogue) {
    const fresh = dialogue.filter(m => !_summarizedSet.has(_fingerprint(m)));
    return fresh;
}

function _markSummarized(fresh) {
    for (const m of fresh) _summarizedSet.add(_fingerprint(m));
    if (_summarizedSet.size > _SUMMARIZED_MAX) {
        console.log('[memory] 已总结指纹超过上限，重置游标');
        _summarizedSet = new Set();
        for (const m of fresh) _summarizedSet.add(_fingerprint(m));
    }
}

let _exitReporting = false;

function flushMemoryToBackend() {
    try {
        if (!voiceChat) return;
        const all = (voiceChat.messages || []).filter(m => m.role !== 'system');
        const fresh = _pickFreshDialogue(all);
        if (fresh.length < 2) return;
        
        return fetch('http://127.0.0.1:6006/v1/memory/session_end', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: fresh }),
        })
            .then(r => r.json())
            .then(r => {
                if (r && r.status === 'success') {
                    _markSummarized(fresh);
                    console.log(`[memory] 已总结本段对话（${fresh.length} 条发言）：新增 ${r.added} 条记忆，遗忘后保留 ${r.kept} 条（删除 ${r.removed} 条）`);
                    if (_exitReporting) {
                        try {
                            _ipcR.send('exit-memory-text', {
                                texts: Array.isArray(r.added_texts) ? r.added_texts : [],
                                stats: { added: r.added, kept: r.kept, removed: r.removed }
                            });
                        } catch (e) {   }
                    }
                } else {
                    console.warn('[memory] 总结未成功', r);
                }
            })
            .catch(e => console.warn('[memory] 总结请求失败', e));
    } catch (e) {
        console.warn('[memory] 总结请求失败', e);
    }
}

let _memorySaved = false;
window.onbeforeunload = () => {
    if (voiceChat) voiceChat.stopRecording();
    if (!_memorySaved) {
        _memorySaved = true;
        try {
            if (!voiceChat) return;
            const all = (voiceChat.messages || []).filter(m => m.role !== 'system');
            const fresh = _pickFreshDialogue(all);
            if (fresh.length < 2) return;
            fetch('http://127.0.0.1:6006/v1/memory/session_end', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: fresh }),
                keepalive: true,
            }).catch(() => {   });
        } catch (_) {   }
    }
};

const { ipcRenderer: _ipcR } = require('electron');

try {
    const DesktopCmd = require('./js/command-router.js')
    DesktopCmd.installCommandRouter({
        ipcRenderer: _ipcR,
        backendUrl: 'http://127.0.0.1:6006/v2',
        log: (m) => {
            console.log('[desktop]', m);
            
            try { _ipcR.send('desktop-log', String(m)); } catch (e) {   }
        },
        onSpoken: (text) => {
            try {
                if (!text) return;
                if (ttsProcessor.isPlaying && ttsProcessor.isPlaying()) return;
                ttsProcessor.processTextToSpeech(String(text));
            } catch (e) {   }
        },
        visionVerifyUrl: 'http://127.0.0.1:6006/v1/vision/verify',
    })
    console.log('[desktop] 鼠标/键盘控制路由已安装')
} catch (e) {
    console.error('[desktop] 路由安装失败:', e)
}

_ipcR.on('flush-memory', () => {
    _exitReporting = true;
    const p = flushMemoryToBackend();
    if (p && typeof p.then === 'function') {
        p.then(() => {
            console.log('[memory] 总结流程结束，通知主进程可以退出');
            try { _ipcR.send('memory-flushed'); } catch (e) {   }
        }).catch(() => {
            try { _ipcR.send('memory-flushed'); } catch (e) {   }
        });
    } else {
        try { _ipcR.send('memory-flushed'); } catch (e) {   }
    }
});


setInterval(flushMemoryToBackend, 3 * 60 * 1000);

let _quitting = false;
_ipcR.on('farewell-and-quit', async () => {
    if (_quitting) return;
    _quitting = true;
    _exitReporting = true;   
    console.log('[exit] 收到关闭指令（无告别 · 静音麦克风）');

    
    try {
        if (voiceChat && voiceChat.asrProcessor &&
            typeof voiceChat.asrProcessor.suspendMic === 'function') {
            voiceChat.asrProcessor.suspendMic(true);
        }
    } catch (e) {   }

    try {
        await Promise.race([
            flushMemoryToBackend(),
            new Promise((resolve) => setTimeout(resolve, 12000)),
        ]);
        console.log('[exit] 记忆已保存');
    } catch (e) {
        console.warn('[exit] 记忆保存失败，仍将退出', e);
    }

    
    console.log('[exit] 通知退出');
    try { _ipcR.send('memory-flushed'); } catch (e) {   }
});
