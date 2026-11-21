const { ipcRenderer } = require('electron');
const { normalizeEmotionKey, pickFallbackGroup } = require('./emotion-keys.js');
const {
    EXPRESSIONS, EXPRESSION_KEYS, ALL_PARAM_IDS, getExpression, flattenParams,
    blendExpressions, microForSignal,
} = require('./expression-map.js');
const { MOTION_BIAS, ACCIDENT_P, planMotion } = require('./motion-policy.js');

const VISIBLE_END_RATIO = 0.42;

const CORNER_Y_OFFSET = 90;

const MAX_VISIBLE_RATIO = 0.45;

const RISE_DURATION = 1050;

const RISE_FROM_RATIO = 0.60;

class ModelInteractionController {
    constructor(config = null) {
        if (config) {
            this.config = config;
        } else {
            try {
                this.config = require('./config-loader.js').configLoader.load() || {};
            } catch (e) {
                this.config = {};
            }
        }
        this.model = null;
        this.app = null;
        this.emotion = null;        
        this._exprParams = {};      
        this._exprHoldTimer = null;
        this._lastMotion = null;
        this._lastMotionEmotionKey = null;  
        this._idleRestoreTimer = null;
        this.interactionWidth = 0;
        this.interactionHeight = 0;
        this.interactionX = 0;
        this.interactionY = 0;
        this.isDragging = false;
        this.dragOffset = { x: 0, y: 0 };
        this._userPinned = false;   
        this._lastWin = { w: 0, h: 0 };
        this._riseRAF = null;
        this._restY = null;
        this._dispW = 0;
        this._dispH = 0;
        this._mouthValue = null;
        this._mouthUntil = 0;
        this._coordScale = 1;
    }

    init(model, app) {
        this.model = model;
        this.app = app;
        this.updateCoordScale();
        this.updateInteractionArea();
        this.setupInteractivity();
        this._installLiveParamHook();
        this._installExpressionHook();
        if (this.config && this.config.ui && this.config.ui.idle_fidget === true) {
            this.scheduleIdleFidget();
        }
    }

    updateCoordScale() {
        this._coordScale = 1;
    }

    updateInteractionArea() {
        if (!this.model) return;

        const dispW = this.model.width || 1;
        const dispH = this.model.height || 1;
        const w = dispW * 0.92;
        const h = dispH * 0.92;
        this.interactionWidth = w;
        this.interactionHeight = h;
        this.interactionX = this.model.x + (dispW - w) / 2;
        this.interactionY = this.model.y + (dispH - h) / 2;
    }

    setupInteractivity() {
        if (!this.model) return;

        this.model.interactive = true;

        const originalContainsPoint = this.model.containsPoint;
        this.model.containsPoint = (point) => this._hitRaw(point.x, point.y);

        this.model.on('mousedown', (e) => {
            const point = e.data.global;
            if (this.model.containsPoint(point)) {
                
                if (this._riseRAF) {
                    cancelAnimationFrame(this._riseRAF);
                    this._riseRAF = null;
                    this.model.alpha = 1;
                }
                this.isDragging = true;
                this.dragOffset.x = point.x - this.model.x;
                this.dragOffset.y = point.y - this.model.y;
                ipcRenderer.send('set-ignore-mouse-events', { ignore: false });
                
                this._userPinned = true;
            }
        });

        this.model.on('mousemove', (e) => {
            if (this.isDragging) {
                const newX = e.data.global.x - this.dragOffset.x;
                const newY = e.data.global.y - this.dragOffset.y;
                this.model.position.set(newX, newY);
                
                this._restY = newY;
                this.updateInteractionArea();
            }
        });

        window.addEventListener('mouseup', () => {
            if (this.isDragging) {
                this.isDragging = false;
                setTimeout(() => {
                    if (!this.model.containsPoint(this.app.renderer.plugins.interaction.mouse.global)) {
                        ipcRenderer.send('set-ignore-mouse-events', {
                            ignore: true,
                            options: { forward: true }
                        });
                    }
                }, 100);
            }
        });

        let _penetrationOn = false;
        const _syncPenetration = (winX, winY) => {
            const on = this._hitModel(winX, winY);
            if (on === _penetrationOn) return;
            _penetrationOn = on;
            if (on) {
                ipcRenderer.send('set-ignore-mouse-events', { ignore: false });
            } else if (!this.isDragging) {
                ipcRenderer.send('set-ignore-mouse-events', {
                    ignore: true,
                    options: { forward: true }
                });
            }
        };

        window.addEventListener('mousemove', (e) => {
            
            if (this.isDragging) return;
            _syncPenetration(e.clientX, e.clientY);
        });

        this.model.on('mouseover', () => {
            if (this.model.containsPoint(this.app.renderer.plugins.interaction.mouse.global)) {
                _penetrationOn = true;
                ipcRenderer.send('set-ignore-mouse-events', { ignore: false });
            }
        });

        this.model.on('mouseout', () => {
            if (!this.isDragging) {
                ipcRenderer.send('set-ignore-mouse-events', {
                    ignore: true,
                    options: { forward: true }
                });
            }
        });

        let _lastClickAt = 0;
        this.model.on('click', (e) => {
            if (!this.model.containsPoint(this.app.renderer.plugins.interaction.mouse.global)
                || !this.model.internalModel) return;
            const point = e && e.data && e.data.global
                ? e.data.global
                : this.app.renderer.plugins.interaction.mouse.global;

            
            const now = Date.now();
            if (now - _lastClickAt < 350) {
                _lastClickAt = 0;
                try { ipcRenderer.send('room-focus'); } catch (err) {   }
                this._logEmotion('双击 → 拉聊天房到前台');
                return;
            }
            _lastClickAt = now;

            const head = this._isHeadHit(point.x, point.y);
            try {
                if (head) {
                    this.model.motion('TapBody', 0, 2);
                    this._scheduleIdleRestore('TapBody');
                    const _pool = ['blush', 'happy', 'shy', 'gentle_smile'];
                    const _pick = _pool[Math.floor(Math.random() * _pool.length)];
                    this.applyEmotion(_pick);
                    this._headPats = (this._headPats || 0) + 1;
                    this._logEmotion(`摸头(第 ${this._headPats} 次) → ${_pick}`);
                    if (typeof this.onHeadPat === 'function') {
                        try { this.onHeadPat(this._headPats, _pick); } catch (err) {   }
                    }
                } else {
                    this.model.motion('TapBody', 0, 2);
                    this._scheduleIdleRestore('TapBody');
                }
            } catch (err) {   }
        });

        const zoomBy = (factor) => {
            const cur = this.model.scale.x;
            const next = cur * factor;
            const base = this._baseScale || cur;
            if (next < base * 0.3 || next > base * 3.0) return;

            const oldW = this.model.width || 1;
            const oldH = this.model.height || 1;
            this.model.scale.set(next);
            const newW = this.model.width || 1;
            const newH = this.model.height || 1;
            this.model.x -= (newW - oldW) / 2;
            this.model.y -= (newH - oldH) / 2;

            if (!this._userPinned) this.layoutToCorner();
            this.updateInteractionArea();
        };

        window.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (this._hitModel(e.clientX, e.clientY)) {
                zoomBy(e.deltaY > 0 ? 0.9 : 1.1);
            } else {
                zoomBy(e.deltaY > 0 ? 0.95 : 1.05);
            }
        }, { passive: false });

    window.addEventListener('resize', () => {
        if (!this.app || !this.app.renderer) return;
        const w = window.innerWidth, h = window.innerHeight;

        const changed = (w !== this._lastWin.w || h !== this._lastWin.h);
        this._lastWin = { w, h };

        this.app.renderer.resize(w, h);
        this.app.stage.position.set(w / 2, h / 2);
        this.app.stage.pivot.set(w / 2, h / 2);

        if (this.model && changed && !this.isDragging && !this._userPinned) {
            this.layoutToCorner();
        }
        this.updateInteractionArea();
    });
    }

    _isHeadHit(gx, gy) {
        if (!this._hitRaw(gx, gy)) return false;
        const w = this.interactionWidth || 0;
        const h = this.interactionHeight || 0;
        if (w <= 0 || h <= 0) return false;
        const x0 = this.interactionX + w * 0.28;
        const x1 = this.interactionX + w * 0.72;
        const y1 = this.interactionY + h * 0.34;
        return gx >= x0 && gx <= x1 && gy >= this.interactionY && gy <= y1;
    }

    _hitRaw(gx, gy) {
        if (gx >= this.interactionX &&
            gx <= this.interactionX + this.interactionWidth &&
            gy >= this.interactionY &&
            gy <= this.interactionY + this.interactionHeight) {
            return true;
        }
        const W = window.innerWidth, H = window.innerHeight;
        if (!this.model) return false;
        if (this.interactionWidth > 0 && this.interactionHeight > 0) return false;
        return (gx >= W * 0.66 && gy >= H * 0.56);
    }

    _hitModel(x, y) {
        return this._hitRaw(x, y);
    }

    setMouthOpenY(v) {
        if (!this.model) return;
        
        this._mouthValue = Math.max(0, Math.min(1.0, +v || 0));
        this._mouthUntil = this._now() + 400;
        this._setEmotionParam('ParamMouthOpenY', this._mouthValue);
    }

    _now() {
        return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    }

    _installLiveParamHook() {
        const im = this.model && this.model.internalModel;
        if (!im || typeof im.update !== 'function' || im._neuroLiveHook) {
            if (!this._hookLog) {
                this._hookLog = true;
                console.log('[mouth] LiveParam hook 未安装: internalModel=',
                    !!im, 'update=', im && typeof im.update,
                    '已装过=', !!(im && im._neuroLiveHook));
            }
            return;
        }
        if (!this._hookLog) {
            this._hookLog = true;
            console.log('[mouth] LiveParam hook 已安装（嘴型写入渲染管线）');
        }
        const orig = im.update.bind(im);
        im.update = (dt, now) => {
            orig(dt, now);
            try {
                this._applyLiveParams();
            } catch (e) {
                
                if (!this._warnedLive) {
                    this._warnedLive = true;
                    console.warn('[口型] 写入失败:', e && (e.message || e));
                }
            }
        };
        im._neuroLiveHook = true;
    }

    _applyLiveParams() {
        if (this._mouthValue === null || this._mouthValue === undefined) return;
        if (this._now() >= this._mouthUntil) return;
        this._setEmotionParam('ParamMouthOpenY', this._mouthValue);
    }

    _EMO_PARAMS = ALL_PARAM_IDS;

    get _EMO_MAP() {
        const out = {};
        for (const key of EXPRESSION_KEYS) {
            const e = EXPRESSIONS[key];
            out[key] = e.params || {};
        }
        return out;
    }

    get _EMO_MOTION() {
        const out = {};
        for (const key of EXPRESSION_KEYS) {
            out[key] = EXPRESSIONS[key].motion || 'Gentle';
        }
        return out;
    }

    _MOTION_COOLDOWN_MS = 2600;

    _MOTION_MAX_MS = {
        Angry: 3200,
        Cheer: 2200,
        Think: 1800,
        Gentle: 4200,
        Sad: 4400,
        TapBody: 2600,
    };
    _MOTION_MAX_MS_DEFAULT = 3000;

    applyEmotion(name, opts) {
        if (!this.model) return;
        const raw = String(name || '').toLowerCase();
        const key = normalizeEmotionKey(raw);
        this.emotion = key;
        const signal = opts && opts.signal;
        const mods = (opts && opts.modifiers) || microForSignal(signal);
        this._exprModifiers = (mods && (!Array.isArray(mods) || mods.length)) ? mods : null;
        if (opts && typeof opts.modifierWeight === 'number' && isFinite(opts.modifierWeight)) {
            this._exprModifierWeight = Math.min(1, Math.max(0, opts.modifierWeight));
        }
        const expr = key ? getExpression(key) : null;
        this._logEmotion(`applyEmotion(${raw}) `
            + `→规范键=${key || '★无'} `
            + `表情="${(expr && expr.face) || '★无'}" `
            + `参数数=${expr ? Object.keys(expr.params || {}).length : 0} `
            + `动作组=${(key && this._EMO_MOTION[key]) || '★无(将回退)'}`);
        this._applyEmotionNow();
        this._decideMotion(key || 'neutral', opts || {});
        this._scheduleExpressionHold(key);
    }

    setExpressionModifiers(modifiers, weight) {
        this._exprModifiers = (modifiers && (!Array.isArray(modifiers) || modifiers.length))
            ? modifiers : null;
        if (typeof weight === 'number' && isFinite(weight)) {
            this._exprModifierWeight = Math.min(1, Math.max(0, weight));
        }
        this._applyEmotionNow();
    }

    _decideMotion(key, opts) {
        const rng = (typeof opts.rng === 'function') ? opts.rng : Math.random;
        const mm = this.model && this.model.internalModel
            && this.model.internalModel.motionManager;
        const defs = mm && mm.definitions;
        const avail = [];
        if (defs) {
            for (const g of Object.keys(defs)) {
                if (g !== 'Idle' && Array.isArray(defs[g]) && defs[g].length) avail.push(g);
            }
        }
        const plan = planMotion(key, {
            lastKey: this._lastMotionEmotionKey || null,
            canonicalGroup: (key && this._EMO_MOTION[key]) || null,
            availableGroups: avail,
            rng,
        });
        
        if (plan.changed) this._lastMotionEmotionKey = key;
        if (plan.play && plan.group) {
            this._playMotionGroup(plan.group, 'emo:' + key, { emotionKey: key });
        }
        return plan;
    }

    _scheduleExpressionHold(key) {
        if (this._exprHoldTimer) { clearTimeout(this._exprHoldTimer); this._exprHoldTimer = null; }
        const expr = key ? getExpression(key) : null;
        if (!expr) return;
        const ms = expr.hold || 3000;
        this._exprHoldTimer = setTimeout(() => {
            this._exprHoldTimer = null;
            
            if (this.emotion !== key) return;
            this._logEmotion(`  · ${key} 保持 ${ms}ms 到 → 回落中性`);
            this.emotion = 'neutral';
            this._applyEmotionNow();
        }, ms);
    }

    _playFallbackMotion(raw) {
        const mm = this.model.internalModel && this.model.internalModel.motionManager;
        const g = pickFallbackGroup(mm && mm.definitions, null);
        if (!g) { this._logEmotion(`  · ${raw} 折不了且模型无可用组，跳过`); return; }
        this._logEmotion(`  · ${raw} 无对应组 → 回退播放 ${g}`);
        this._playMotionGroup(g, 'fallback');
    }

    _playEmotionMotion(key) {
        const group = this._EMO_MOTION[key];
        if (!group) {
            this._logEmotion(`  · ${key} 无动作组映射 → 回退随机组`);
            return this._playFallbackMotion(key);
        }
        if (!this.model || !this.model.internalModel) {
            this._logEmotion(`  · ${key}/${group} 模型未就绪，跳过`);
            return;
        }
        const mm = this.model.internalModel.motionManager;
        const defs = mm && mm.definitions ? mm.definitions[group] : null;
        const n = defs && defs.length ? defs.length : 0;
        if (!n) {
            const allGroups = (mm && mm.definitions) ? Object.keys(mm.definitions) : [];
            this._logEmotion(`  ★ ${group} 组不存在或为空 → 回退随机组。`
                + `模型实际有的组: [${allGroups.join(', ')}]`);
            return this._playFallbackMotion(key + '/' + group);
        }
        this._playMotionGroup(group, key);
    }

    _playMotionGroup(group, why, opts = {}) {
        if (!group) return;
        if (!this.model || !this.model.internalModel) {
            this._logEmotion(`  · ${why}/${group} 模型未就绪，跳过`);
            return;
        }
        const now = Date.now();
        const cooldown = (opts.cooldownMs != null) ? opts.cooldownMs : this._MOTION_COOLDOWN_MS;
        if (this._lastMotion && this._lastMotion.group === group
            && now - this._lastMotion.at < cooldown) {
            this._logEmotion(`  · ${group} 冷却中(${cooldown}ms)，跳过`);
            return;   
        }
        const mm = this.model.internalModel.motionManager;
        const defs = mm && mm.definitions ? mm.definitions[group] : null;
        const n = defs && defs.length ? defs.length : 0;
        if (!n) {
            this._logEmotion(`  ★ ${group} 组不存在或为空（回退链末端），跳过`);
            return;
        }
        const idx = (this._lastMotion && this._lastMotion.group === group)
            ? (this._lastMotion.idx + 1) % n
            : Math.floor(Math.random() * n);
        try {
            const p = this.model.motion(group, idx, 3);
            if (p && typeof p.then === 'function') {
                p.then((ok) => {
                    if (ok === false) {
                        this._logEmotion(`  ★ motion(${group}[${idx}]) 返回 false`
                            + `（组名对但文件加载失败？看后端/控制台的 loadMotion 报错）`);
                        return;
                    }
                    this._logEmotion(`  → 已播放 ${group}[${idx}] (共${n}个) [${why}]`);
                }).catch((e) => {
                    this._logEmotion(`  ★ motion(${group}[${idx}]) 异步失败:`
                        + `${e && (e.message || e)}`);
                });
            } else {
                this._logEmotion(`  → 已调用 motion(${group}[${idx}]) (共${n}个) [${why}]`);
            }
            this._lastMotion = { group, idx, at: now };
            this._scheduleIdleRestore(group, opts.maxMs);
        } catch (e) {
            
            this._logEmotion(`  ★ motion(${group}) 同步抛错: ${e && e.message}`);
        }
    }

    setSpeakingChecker(fn) {
        this._speakingChecker = (typeof fn === 'function') ? fn : null;
    }

    scheduleIdleFidget() {
        if (this._fidgetTimer) clearTimeout(this._fidgetTimer);
        const delay = 18000 + Math.random() * 24000;
        this._fidgetTimer = setTimeout(() => {
            this._fidgetTimer = null;
            try { this._maybeFidget(); } catch (e) {   }
            this.scheduleIdleFidget();
        }, delay);
    }

    _maybeFidget() {
        if (!this.model || !this.model.internalModel) return;
        if (this._speakingChecker && this._speakingChecker()) return;
        const now = Date.now();
        if (this._lastMotion && now - this._lastMotion.at < 6000) return;
        const mm = this.model.internalModel.motionManager;
        const g = pickFallbackGroup(mm && mm.definitions,
            this._lastMotion && this._lastMotion.group);
        if (!g) return;
        this._logEmotion(`[fidget] 空闲小动作 → ${g}`);
        this._playMotionGroup(g, 'fidget', { cooldownMs: 4000, maxMs: 2600 });
    }

    _scheduleIdleRestore(group, maxMsOverride) {
        if (this._idleRestoreTimer) clearTimeout(this._idleRestoreTimer);
        const ms = (maxMsOverride != null) ? maxMsOverride
            : (this._MOTION_MAX_MS[group] || this._MOTION_MAX_MS_DEFAULT);
        this._idleRestoreTimer = setTimeout(() => {
            this._idleRestoreTimer = null;
            if (!this.model || !this.model.internalModel) return;
            try {
                this.model.motion('Idle', 0, 3);
            } catch (e) {   }
        }, ms);
    }

    clearEmotion() {
        this.emotion = null;
        if (this._exprHoldTimer) { clearTimeout(this._exprHoldTimer); this._exprHoldTimer = null; }
        this._resetEmotionParams();
    }

    _applyEmotionNow() {
        const expr = this.emotion ? getExpression(this.emotion) : null;
        let flat = flattenParams(expr);
        if (this._exprModifiers) {
            flat = blendExpressions(flat, this._exprModifiers,
                (typeof this._exprModifierWeight === 'number') ? this._exprModifierWeight : 0.45);
        }
        const prev = this._exprParams || {};
        for (const id of Object.keys(prev)) {
            if (!(id in flat)) this._setEmotionParam(id, 0);
        }
        for (const id of Object.keys(flat)) {
            this._setEmotionParam(id, flat[id]);
        }
        this._exprParams = flat;
        this._exprTargetVersion = (this._exprTargetVersion || 0) + 1;
    }

    _resetEmotionParams() {
        for (const p of this._EMO_PARAMS) this._setEmotionParam(p, 0);
        this._exprParams = {};
    }

    _installExpressionHook() {
        const im = this.model && this.model.internalModel;
        if (!im || typeof im.on !== 'function') {
            console.warn('[表情] afterMotionUpdate 钩子未安装：internalModel 不可用');
            return;
        }
        if (im._neuroExprHook) return;
        im.on('afterMotionUpdate', () => {
            try {
                this._applyExpressionParams();
                this._applyLiveParams();
            } catch (e) {
                if (!this._warnedExpr) {
                    this._warnedExpr = true;
                    console.warn('[表情] 每帧写入失败:', e && (e.message || e));
                }
            }
        });
        im._neuroExprHook = true;
        this._logEmotion('[表情] afterMotionUpdate 钩子已安装（表情参数每帧生效）');
    }

    _applyExpressionParams() {
        const target = this._exprParams || {};
        const cm = this.model.internalModel.coreModel;
        let smoothMs = this._exprSmoothMs;
        if (smoothMs == null) {
            const ui = (this.config && this.config.ui) || {};
            smoothMs = ui.expression_smooth_ms || 0;
            this._exprSmoothMs = smoothMs;
        }
        if (!smoothMs) {
            
            for (const id of Object.keys(target)) cm.setParameterValueById(id, target[id]);
            return;
        }

        const now = this._now();
        if (!this._exprRender) this._exprRender = Object.assign({}, target);
        if (this._exprRenderedVersion !== this._exprTargetVersion) {
            this._exprRenderedVersion = this._exprTargetVersion;
            this._exprTransitionStart = now;
        }
        const t = Math.min(1, Math.max(0, (now - this._exprTransitionStart) / smoothMs));
        const ids = {};
        for (const id of Object.keys(this._exprRender)) ids[id] = true;
        for (const id of Object.keys(target)) ids[id] = true;
        const out = {};
        for (const id of Object.keys(ids)) {
            const from = this._exprRender[id] || 0;
            const to = target[id] || 0;
            out[id] = from + (to - from) * t;
        }
        this._exprRender = (t >= 1) ? Object.assign({}, target) : out;
        for (const id of Object.keys(out)) cm.setParameterValueById(id, out[id]);
    }

    
    _setPair(leftId, rightId, v) {
        this._setEmotionParam(leftId, v);
        this._setEmotionParam(rightId, v);
    }

    _setEmotionParam(id, v) {
        try {
            const cm = this.model.internalModel.coreModel;
            cm.setParameterValueById(id, v);
        } catch (e) {
            if (!this._warnedParams) this._warnedParams = new Set();
            if (!this._warnedParams.has(id)) {
                this._warnedParams.add(id);
                console.warn('[表情] 模型无此参数(检查拼写):', id);
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

    setupInitialModelProperties(scaleOrHeight) {
        if (!this.model || !this.app) return;

        const targetH = (typeof scaleOrHeight === 'number' && scaleOrHeight > 20)
            ? scaleOrHeight
            : 320;

        this.model.scale.set(1);
        this.model.getBounds(true);
        const rawW = this.model.width || 1;
        const rawH = this.model.height || 1;
        if (rawH <= 1) return;

        let fullH = targetH / VISIBLE_END_RATIO;

        const winH = window.innerHeight || 1080;
        const canvasH = (this.app.renderer && this.app.renderer.height) || winH;
        const targetVisible = Math.min(targetH, winH * MAX_VISIBLE_RATIO);
        fullH = targetVisible / VISIBLE_END_RATIO;

        let scale = fullH / rawH;

        const maxScale = (canvasH * 0.98) / rawH;
        if (scale > maxScale) scale = maxScale;

        this.model.scale.set(scale);
        this._baseScale = scale;

        this.layoutToCorner();
        console.log(`[Live2D] 缩放=${scale.toFixed(3)} 原始尺寸=${Math.round(rawW)}x${Math.round(rawH)} `
            + `当前显示=${Math.round(this.model.width)}x${Math.round(this.model.height)} `
            + `可见(头顶→腰)=${Math.round(this.model.height * VISIBLE_END_RATIO)}px `
            + `位置=(${Math.round(this.model.x)},${Math.round(this.model.y)}) `
            + `画布=${this.app.renderer.width}x${this.app.renderer.height} `
            + `窗口=${window.innerWidth}x${window.innerHeight}`);
        this.updateInteractionArea();
        this._dumpHitTest();
    }

    _dumpHitTest() {
        const b = (() => { try { return this.model.getBounds(true); } catch (e) { return null; } })();
        const line = `[Live2D] 命中判定: 换算系数=${this._coordScale.toFixed(3)} `
            + `(画布${this.app.renderer.width}x${this.app.renderer.height} / 窗口${window.innerWidth}x${window.innerHeight}) `
            + `模型bounds=(${Math.round(b ? b.x : -1)},${Math.round(b ? b.y : -1)}) `
            + `${Math.round(b ? b.width : 0)}x${Math.round(b ? b.height : 0)} `
            + `判定框=(${Math.round(this.interactionX)},${Math.round(this.interactionY)}) `
            + `${Math.round(this.interactionWidth)}x${Math.round(this.interactionHeight)}`;
        console.log(line);
        try {
            const fs = require('fs');
            const p = require('path');
            const dir = p.join(__dirname, '..', 'logs');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.appendFileSync(p.join(dir, 'hit_test.log'), `${new Date().toISOString()} ${line}\n`);
        } catch (e) {   }
    }

    layoutToCorner() {
        if (!this.model) return;

        const dispW = this.model.width || 1;
        const dispH = this.model.height || 1;
        this._dispW = dispW;
        this._dispH = dispH;

        const winW = window.innerWidth || 1920;
        const winH = window.innerHeight || 1080;

        const margin = -70;
        const visibleFromTop = dispH * VISIBLE_END_RATIO;

        let x = winW - dispW - margin;
        let y = winH - visibleFromTop - CORNER_Y_OFFSET;
        if (y < 0) y = 0;
        if (x < -dispW * 0.5) x = -dispW * 0.5;

        this._restY = y;
        this.model.x = x;
        this.model.y = y;
    }

    playEntranceAnimation(riseFrom = null) {
        if (!this.model) return;
        const restY = (this._restY !== undefined && this._restY !== null) ? this._restY : this.model.y;
        const startY = (riseFrom !== null) ? riseFrom
            : (window.innerHeight + this.model.height * RISE_FROM_RATIO);
        const startX = this.model.x;

        this.model.x = startX;
        this.model.y = startY;
        this.model.alpha = 1;

        const t0 = performance.now();
        const dur = RISE_DURATION;
        const ease = (t) => 1 - Math.pow(1 - t, 4);

        const step = (now) => {
            const t = Math.min(1, (now - t0) / dur);
            const e = ease(t);
            this.model.y = startY + (restY - startY) * e;
            this.model.alpha = 1;
            this.updateInteractionArea();
            if (t < 1) {
                this._riseRAF = requestAnimationFrame(step);
            } else {
                this.model.y = restY;
                this.model.alpha = 1;
                this._riseRAF = null;
                this.updateInteractionArea();
            }
        };
        if (this._riseRAF) cancelAnimationFrame(this._riseRAF);
        this._riseRAF = requestAnimationFrame(step);
    }
}

module.exports = { ModelInteractionController, RISE_DURATION };
