'use strict';

const HER_NAMES = ['neuro'];

const QUESTION_TAIL = /[?？]\s*$/;
const QUESTION_WORDS = /^\s*(what|why|how|who|when|where|which|are you|is it|do you|can you|could you|would you|will you|did you|does|吗|呢|什么|怎么|为什么|是不是|要不要|能不能|可不可以)/i;

const FILLER_RE = /^(嗯+|哦+|啊+|呃+|唔+|呀+|哎+|哈+|呵+|嘿嘿+|哈哈哈+|ok+|okay|yes|no|yeah|yep|nope|好的|好哒|行|可以|对|是的|收到|知道|知道了|了解|[.。!！?？,，、~～\s]+)$/i;

const AMBIENT_MIN_WORDS = 18;

const DEFAULTS = {
    enabled: false,
    rate: 0.55,
    cooldown_s: 12,
    react: true,
    always: 0.85,
    never: 0.12,
};

function evaluateResponseGate(text, state = {}) {
    const cfg = Object.assign({}, DEFAULTS, state.config || {});
    const rng = typeof state.rng === 'function' ? state.rng : Math.random;
    const now = state.now || Date.now();
    const t = String(text || '');
    const clean = t.trim();
    const lower = clean.toLowerCase();
    const reasons = [];
    let score = cfg.rate;

    const named = HER_NAMES.some((n) => lower.includes(n));
    if (named) { score += 0.45; reasons.push('喊了她+0.45'); }

    const isQuestion = QUESTION_TAIL.test(clean) || QUESTION_WORDS.test(lower);
    if (isQuestion) { score += 0.30; reasons.push('是问句+0.30'); }

    const words = clean.split(/\s+/).filter(Boolean);
    if (!named && (clean.length <= 3 || FILLER_RE.test(clean))) {
        score -= 0.35;
        reasons.push('语气词/太短-0.35');
        return {
            score: Math.min(score, cfg.never),
            decision: 'ignore',
            reasons: reasons.concat('纯语气词→直接沉默，不给掷骰'),
            named, isQuestion,
        };
    }
    if (!named && !isQuestion && words.length >= AMBIENT_MIN_WORDS) {
        score -= 0.30; reasons.push('像自言自语/朗读-0.30');
    }
    const sinceReply = now - (state.lastReplyAt || 0);
    if (state.lastReplyAt && sinceReply < cfg.cooldown_s * 1000 && !named) {
        score -= 0.25; reasons.push(`她${(sinceReply / 1000).toFixed(0)}s前才说完-0.25`);
    }
    if (state.busy && !named) {
        score -= 0.20; reasons.push('她正说着-0.20');
    }

    score = Math.max(0, Math.min(1, score));

    let decision;
    if (score >= cfg.always) {
        decision = 'answer';
        reasons.push(`分够高(${score.toFixed(2)}≥${cfg.always})必答`);
    } else if (score <= cfg.never) {
        decision = 'ignore';
        reasons.push(`分太低(${score.toFixed(2)}≤${cfg.never})沉默`);
    } else {
        const roll = rng();
        if (roll < score) {
            decision = 'answer';
            reasons.push(`掷骰${roll.toFixed(2)}<${score.toFixed(2)}→答`);
        } else {
            decision = cfg.react ? 'react' : 'ignore';
            reasons.push(`掷骰${roll.toFixed(2)}≥${score.toFixed(2)}→${decision === 'react' ? '不理但给反应' : '沉默'}`);
        }
    }

    return { score, decision, reasons, named, isQuestion };
}

module.exports = { evaluateResponseGate, DEFAULTS };
