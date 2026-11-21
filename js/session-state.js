'use strict';

const COMMIT_HOLD_MS = 2500;

const WAIT_HOLD_MS = 8000;

const MAX_HOLD_MS = 12000;

const MIN_COMMIT_CHARS = 1;

const WAIT_PATTERNS = [
    /等一下/, /等下/, /等等我?/, /稍等/, /且慢/, /先别/,
    /让我想想/, /我想想/, /我想一下/, /我考虑一下/, /容我想想/,
    /\bhold\s*on\b/i, /\bwait\b/i, /\bone\s+(?:sec|second|moment)\b/i,
    /\blet\s+me\s+(?:think|see)\b/i, /\bgive\s+me\s+a\s+(?:sec|second|moment)\b/i,
    /\bhmm+\b/i, /\bum+\b/i,
];

const FAST_FINISH = /^(?:好的?|好吧|行|可以|对|是的|知道了|收到|没问题|没了|就这些|算了|谢谢|不要了|不用了|嗯好|ok|okay|yes|yep|sure|done|got it|thanks|no|nope|nah)[.。!！~～?？\s]*$/i;

const SENTENCE_END = /[。！？!?….;；]["'）)\]]*\s*$/;

const DANGLING_TAIL = /(?:然后|但是|但|还有|和|跟|或者|而|且|以及|因为|所以|如果|那个|就是|嗯|呃|and|but|or|because|so|then|which|that|the|a|an|to|of|with|about)$/i;

function joinUtterances(a, b) {
    let left = String(a == null ? '' : a).trim();
    const right = String(b == null ? '' : b).trim();
    if (!left) return right;
    if (!right) return left;
    left = left.replace(/[。．.！!？?，,；;]+$/u, '');
    const sep = /[\u4e00-\u9fff]/.test(right.charAt(0)) ? '' : ' ';
    return left + sep + right;
}

function isWaitCue(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return false;
    return WAIT_PATTERNS.some(re => re.test(s));
}


function isFastFinish(text) {
    return FAST_FINISH.test(String(text == null ? '' : text).trim());
}

function looksComplete(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return false;
    if (SENTENCE_END.test(s)) return true;
    if (DANGLING_TAIL.test(s)) return false;
    return s.length >= 14;
}

const STATE = Object.freeze({
    IDLE: 'idle',
    COLLECTING: 'collecting',
    WAITING: 'waiting',
    ANSWERING: 'answering',
});

const TRANSITIONS = Object.freeze({
    idle:       ['collecting', 'waiting'],
    collecting: ['collecting', 'waiting', 'answering', 'idle'],
    waiting:    ['collecting', 'waiting', 'answering', 'idle'],
    answering:  ['idle', 'collecting'],
});

class UserTurnSession {
    constructor(opts = {}) {
        this.onCommit = typeof opts.onCommit === 'function' ? opts.onCommit : () => {};
        this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
        this.commitHoldMs = opts.commitHoldMs != null ? opts.commitHoldMs : COMMIT_HOLD_MS;
        this.waitHoldMs = opts.waitHoldMs != null ? opts.waitHoldMs : WAIT_HOLD_MS;
        this.maxHoldMs = opts.maxHoldMs != null ? opts.maxHoldMs : MAX_HOLD_MS;

        this.state = STATE.IDLE;
        this.taskId = 0;
        this.segments = [];
        this.text = '';
        this.raw = '';
        this.startedAt = 0;
        this.deadlineAt = 0;
        this.lastAt = 0;
        this.commitCount = 0;
        this.droppedStale = 0;
        this.lastCommit = null;
        this._history = [];
    }

    
    _to(next, reason) {
        if (next === this.state) return true;
        const allowed = TRANSITIONS[this.state] || [];
        if (!allowed.includes(next)) {
            this._history.push({ from: this.state, to: next, ok: false, reason, at: this._now() });
            return false;
        }
        this._history.push({ from: this.state, to: next, ok: true, reason, at: this._now() });
        this.state = next;
        return true;
    }

    _begin(reason) {
        this.taskId += 1;
        this.segments = [];
        this.text = '';
        this.raw = '';
        this.startedAt = this._now();
        this.lastAt = this.startedAt;
        this.commitCount = this.commitCount || 0;
        if (this.state !== STATE.IDLE) this._to(STATE.IDLE, 'begin_boundary');
        this._to(STATE.COLLECTING, reason);
        return this.taskId;
    }

    _armDeadline(waiting) {
        const now = this._now();
        const hold = waiting ? this.waitHoldMs : this.commitHoldMs;
        const soft = this.lastAt + hold;
        const hard = this.startedAt + Math.max(this.maxHoldMs, hold);
        this.deadlineAt = waiting ? soft : Math.min(soft, hard);
        return this.deadlineAt;
    }

    push(text, opts = {}) {
        const t = String(text == null ? '' : text).trim();
        if (!t) {
            return { accepted: false, committed: false, taskId: this.taskId,
                     state: this.state, reason: 'empty' };
        }
        const now = this._now();
        const incomingTaskId = opts.taskId;
        const isBarge = !!opts.duringTts;

        const wasActive = (this.state === STATE.COLLECTING || this.state === STATE.WAITING);
        const needNew = (this.state === STATE.IDLE)
            || (this.state === STATE.ANSWERING)
            || (opts.newTurn === true);
        if (needNew) this._begin(isBarge ? 'barge_in' : 'first_segment');

        if (wasActive && !needNew && incomingTaskId != null
                && incomingTaskId !== this.taskId && !isBarge) {
            this.droppedStale += 1;
            return { accepted: false, committed: false, taskId: this.taskId,
                     state: this.state, reason: 'stale_task_id' };
        }

        this.segments.push({ text: t, raw: opts.raw || '', taskId: this.taskId, at: now });
        this.text = joinUtterances(this.text, t);
        this.raw = joinUtterances(this.raw, opts.raw || t);
        this.lastAt = now;

        const waitCue = isWaitCue(t);
        const fast = isFastFinish(t);

        if (waitCue) {
            this._to(STATE.WAITING, 'wait_cue');
            this._armDeadline(true);
            return { accepted: true, committed: false, taskId: this.taskId,
                     state: this.state, reason: 'wait_cue' };
        }
        if (this.state === STATE.WAITING) {
            this._to(STATE.COLLECTING, 'resumed_after_wait');
        }

        if (isBarge) {
            return this._commit('barge_in');
        }
        if (opts.force === true || (fast && this.segments.length === 1)) {
            return this._commit('fast_finish');
        }

        this._armDeadline(false);
        return { accepted: true, committed: false, taskId: this.taskId,
                 state: this.state, reason: looksComplete(t) ? 'collecting_complete' : 'collecting' };
    }

    tick(nowMs) {
        const now = (typeof nowMs === 'number') ? nowMs : this._now();
        if (this.state !== STATE.COLLECTING && this.state !== STATE.WAITING) {
            return { committed: false, reason: 'not_collecting' };
        }
        if (!this.text.trim()) return { committed: false, reason: 'empty' };
        if (now < this.deadlineAt) return { committed: false, reason: 'waiting' };
        const reason = (this.state === STATE.WAITING) ? 'wait_timeout' : 'silence_timeout';
        return this._commit(reason);
    }

    
    _commit(reason) {
        const text = this.text.trim();
        if (!text || text.length < MIN_COMMIT_CHARS) {
            this._to(STATE.IDLE, 'empty_commit');
            this._clear();
            return { accepted: true, committed: false, taskId: this.taskId,
                     state: this.state, reason: 'empty_commit' };
        }
        const payload = {
            text,
            raw: this.raw.trim(),
            taskId: this.taskId,
            reason,
            segments: this.segments.slice(),
            waited: (this._now() - this.startedAt),
            fromState: this.state,
        };
        this._to(STATE.ANSWERING, reason);
        this.commitCount += 1;
        this.lastCommit = payload;
        this.deadlineAt = 0;
        try {
            this.onCommit(payload);
        } catch (e) {
            
            payload.callbackError = String(e && e.message || e);
        }
        return { accepted: true, committed: true, taskId: payload.taskId,
                 state: this.state, reason };
    }

    _clear() {
        this.segments = [];
        this.text = '';
        this.raw = '';
        this.startedAt = 0;
        this.lastAt = 0;
        this.deadlineAt = 0;
    }

    commit(reason = 'manual') {
        if (this.state !== STATE.COLLECTING && this.state !== STATE.WAITING) {
            return { committed: false, reason: 'not_collecting' };
        }
        return this._commit(reason);
    }

    interrupt(reason = 'interrupt') {
        const had = (this.state === STATE.COLLECTING || this.state === STATE.WAITING);
        this._clear();
        this._to(STATE.IDLE, reason);
        this.taskId += 1;
        this.droppedStale = this.droppedStale || 0;
        return { taskId: this.taskId, discarded: had, state: this.state };
    }

    currentTaskId() { return this.taskId; }

    finishAnswer() {
        if (this.state === STATE.ANSWERING) this._to(STATE.IDLE, 'answer_finished');
        return this.state;
    }

    snapshot() {
        return {
            state: this.state,
            taskId: this.taskId,
            text: this.text,
            segmentCount: this.segments.length,
            startedAt: this.startedAt,
            deadlineAt: this.deadlineAt,
            commitCount: this.commitCount,
            droppedStale: this.droppedStale,
            transitions: this._history.slice(),
        };
    }
}

module.exports = {
    UserTurnSession,
    STATE,
    TRANSITIONS,
    COMMIT_HOLD_MS,
    WAIT_HOLD_MS,
    MAX_HOLD_MS,
    WAIT_PATTERNS,
    joinUtterances,
    isWaitCue,
    isFastFinish,
    looksComplete,
};
