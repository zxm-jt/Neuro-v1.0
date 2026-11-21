(function () {
    'use strict';

    var stateVisual = {
        _current: 'idle',
        _raf: null,
        _lastTs: 0,
        _intervalMs: 120,
        _interruptUntil: 0,
        _deps: null,
    };

    
    stateVisual.attach = function (deps) {
        stateVisual._deps = deps || null;
    };

    function _dep(name) {
        return (stateVisual._deps && stateVisual._deps[name]) || null;
    }

    function _computeState() {
        var now = Date.now();

        if (now < stateVisual._interruptUntil) {
            return 'interrupted';
        }

        var tts = _dep('ttsProcessor');
        var vc = _dep('voiceChat');
        var asr = _dep('asrProcessor');

        if (tts && typeof tts.isPlaying === 'function' && tts.isPlaying()) {
            return 'speaking';
        }

        if (vc && vc._abortController) {
            return 'thinking';
        }

        if (asr && asr.isRecording && asr.isRecording && !_isMuted(asr)) {
            return 'listening';
        }

        if (window.__neuroVisionActive && now < window.__neuroVisionActive) {
            return 'vision';
        }

        if (_isMuted(asr)) {
            return 'muted';
        }

        return 'idle';
    }

    function _isMuted(asr) {
        if (!asr) return false;
        if (asr._bargeMuteActive) return true;
        if (typeof asr.isSuspended === 'function' && asr.isSuspended()) return true;
        return false;
    }

    function _apply(state) {
        if (state === stateVisual._current) return;
        stateVisual._current = state;
        document.body.setAttribute('data-state', state);
        var label = {
            idle: '', listening: '正在聆听', thinking: '思考中',
            speaking: '', interrupted: '已打断', muted: '麦克风已关闭',
            vision: '正在看你的屏幕',
        }[state] || '';
        var chip = document.getElementById('state-chip');
        if (chip) {
            chip.setAttribute('data-label', label);
            chip.textContent = label;
        }
        var ann = document.getElementById('state-live');
        if (ann) {
            ann.textContent = label;
        }
    }

    function _tick(now) {
        stateVisual._raf = requestAnimationFrame(_tick);
        if (now - stateVisual._lastTs < stateVisual._intervalMs) return;
        stateVisual._lastTs = now;
        _apply(_computeState());
    }

    stateVisual.start = function () {
        if (stateVisual._raf) return;
        stateVisual._lastTs = 0;
        
        _apply(_computeState());
        stateVisual._raf = requestAnimationFrame(_tick);
    };

    stateVisual.stop = function () {
        if (stateVisual._raf) {
            cancelAnimationFrame(stateVisual._raf);
            stateVisual._raf = null;
        }
        _apply('idle');
    };

    
    stateVisual.flashInterrupt = function () {
        stateVisual._interruptUntil = Date.now() + 220;
        _apply('interrupted');
    };

    window.__stateVisual = stateVisual;

    function _boot() {
        if (!document.getElementById('state-chip')) {
            return;
        }
        stateVisual.attach({
            ttsProcessor: window.ttsProcessor || null,
            voiceChat: window.voiceChat || null,
            asrProcessor: (window.voiceChat && window.voiceChat.asrProcessor) || null,
        });
        stateVisual.start();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _boot);
    } else {
        _boot();
    }
})();
