const ACK_ONLY = [
    'oh', 'ah', 'ahh', 'hmm', 'hm', 'mm', 'mhm', 'uh', 'um', 'er', 'eh',
    'yeah', 'yea', 'yep', 'yup', 'ok', 'okay', 'k', 'kk', 'sure', 'right',
    'true', 'indeed', 'exactly', 'alright', 'right', 'wow', 'ohh',
    'uh-huh', 'mm-hmm', 'yeah-yeah', 'yup-yup', 'hmm-hmm', 'mhm-mhm',
    '嗯', '唔', '啊', '哦', '噢', '对', '是的', '好的', '行', '好',
];

const REDIRECT_MARKERS = [
    'no', 'not', 'wait', 'actually', 'but', 'instead', 'rather',
    'change', 'wrong', 'mistake', 'i mean', "i'm saying", 'hold on',
    'correction', 'different', 'never mind', 'nevermind', 'scratch that',
    '不对', '不是', '等等', '其实', '我是说', '改', '换成', '不要', '先别',
];

const REDIRECT_RE_EN = new RegExp(
    '\\b(' + [
        'no', 'not', 'wait', 'actually', 'but', 'instead', 'rather',
        'change', 'wrong', 'mistake', "i mean", "i'm saying", 'hold on',
        'correction', 'different', 'never mind', 'nevermind', 'scratch that',
    ].join('|') + ')\\b', 'i');
const REDIRECT_MARKERS_CJK = REDIRECT_MARKERS.filter((m) => /[\u4e00-\u9fff]/.test(m));

const MIN_MEANINGFUL_LEN = 6;
const MIN_MEANINGFUL_LEN_CJK = 4;

function hasCJK(s) {
    return /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(String(s || ''));
}

function norm(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function splitAckAndContent(text) {
    const raw = String(text || '').trim();
    if (!raw) return { ack: '', content: '' };
    const words = raw.split(/\s+/);
    let i = 0;
    const ackParts = [];
    while (i < words.length && i < 2) {
        const w = words[i].replace(/[^\p{L}\p{N}-]/gu, '');
        if (ACK_ONLY.includes(w.toLowerCase())) {
            ackParts.push(words[i]);
            i++;
        } else {
            break;
        }
    }
    const ack = ackParts.join(' ');
    const content = words.slice(i).join(' ');
    return { ack, content };
}

function classifyInterruption(text, opts = {}) {
    const raw = String(text || '').trim();
    if (!raw) {
        return { kind: 'none', reason: '空输入', content: '' };
    }
    if (!opts.isSpeaking) {
        return { kind: 'none', reason: '她没在说话', content: raw };
    }

    const { ack, content } = splitAckAndContent(raw);
    const normContent = norm(content);

    const lowRaw = raw.toLowerCase();
    const _enHit = lowRaw.match(REDIRECT_RE_EN);
    const _cjkHit = REDIRECT_MARKERS_CJK.find((m) => lowRaw.includes(m));
    const _hit = _enHit ? _enHit[0] : _cjkHit;
    if (_hit) {
        return {
            kind: 'interrupt',
            reason: `含改向信号「${_hit}」`,
            content: raw,
        };
    }

    if (normContent) {
        const minLen = hasCJK(normContent) ? MIN_MEANINGFUL_LEN_CJK : MIN_MEANINGFUL_LEN;
        if (normContent.length >= minLen) {
            return {
                kind: 'interrupt',
                reason: `有实质内容（${normContent.length} 字符）`,
                content: raw,
            };
        }
    }

    if (ack && !content) {
        return { kind: 'ack', reason: '只有语气词', content: '' };
    }

    if (normContent && normContent.length < (hasCJK(normContent) ? MIN_MEANINGFUL_LEN_CJK : MIN_MEANINGFUL_LEN)) {
        const neg = ['不', '别', '停', '错', '不对', 'no', 'stop', 'wrong', 'nope'];
        if (neg.includes(normContent)) {
            return { kind: 'interrupt', reason: '明确否定', content: raw };
        }
        return { kind: 'ack', reason: '太短，像反馈', content: '' };
    }

    return { kind: 'interrupt', reason: '默认视为新内容', content: raw };
}

const MAX_USER_ADDS = 3;

class InterruptState {
    constructor(turnId) {
        this.turnId = turnId || 0;
        this.generated = '';
        this.spoken = '';
        this.unspoken = '';
        this.userAdds = [];
        this.baseUserText = '';
        this.phase = 'streaming';
        this.ackOnly = false;
        this.boundary = null;
        
        this.discarded = false;
    }

    appendGenerated(chunk) {
        if (!chunk) return;
        this.generated += chunk;
    }

    updateSpoken(spokenSoFar) {
        if (typeof spokenSoFar === 'string') {
            this.spoken = spokenSoFar;
        }
        const idx = this.generated.indexOf(this.spoken);
        if (idx >= 0 && this.spoken.length > 0) {
            this.unspoken = this.generated.slice(idx + this.spoken.length);
        } else {
            this.unspoken = '';
        }
    }

    addUserInput(text) {
        if (!text) return;
        this.userAdds.push(String(text));
        if (this.userAdds.length > MAX_USER_ADDS) {
            this.userAdds.splice(0, this.userAdds.length - MAX_USER_ADDS);
        }
    }

    addUserInputSmart(text, opts = {}) {
        const cls = classifyInterruption(text, { isSpeaking: true, ...opts });
        if (cls.kind === 'ack') {
            this.ackOnly = true;
            return cls;
        }
        this.userAdds.push(String(text || ''));
        if (this.userAdds.length > MAX_USER_ADDS) {
            this.userAdds.splice(0, this.userAdds.length - MAX_USER_ADDS);
        }
        return cls;
    }

    mergedUserAdds() {
        return this.userAdds.slice(-MAX_USER_ADDS).join(' ').trim().slice(0, 240);
    }

    currentTopic() {
        const g = norm(this.spoken || this.generated);
        if (!g) return '';
        const parts = g.split(/(?<=[.!?。！？])\s*/);
        return (parts[parts.length - 1] || g).slice(0, 200);
    }

    buildResumePrompt() {
        const adds = this.mergedUserAdds();
        const heard = (this.spoken || '').trim();
        const unfinished = (this.unspoken || '').trim();
        const topic = this.currentTopic();

        let p = '';
        p += '【INTERRUPTION CONTEXT】\n';
        p += `You were interrupted while speaking.\n`;

        const bd = this.boundary;
        if (bd && (bd.completedSegments || []).length) {
            const tail = norm((bd.completedSegments || []).join(' ')).slice(-64);
            p += `You already finished your previous line (tail: "...${tail}"). `
               + `It is OLD content. Never quote, repeat or paraphrase it.\n`;
        }
        if (bd && bd.currentSegment) {
            const _done = bd.currentPartial || '';
            const _rest = bd.currentSegment.slice(_done.length);
            if (_done) {
                p += `You were in the middle of this sentence: "${_done}"\n`;
            }
            if (_rest) {
                p += `You had NOT yet said the rest of it: "${_rest}"\n`;
            }
        }
        if (bd && bd.unplayedText) {
            p += `You had not played this part at all: "${bd.unplayedText}"\n`;
        }
        
        if (!bd && heard) {
            const _head = heard.slice(0, 60);
            p += `You already started saying: "${_head}..." - do NOT repeat that part, `
              + `continue from where you stopped.\n`;
        }
        if (!bd && unfinished) {
            p += `You were about to continue with this idea: "${unfinished}"\n`;
        }
        if (topic) {
            
            p += `The old line ended with: "...${norm(topic).slice(-64)}"\n`;
        }
        if (adds) {
            p += `user spoke over you and said: "${adds}"\n`;
            p += `Decide which of these two it was, then act on it:\n`;
            p += `  (A) His words did NOT change what you were saying - he was just `
               + `reacting, agreeing, adding a small detail, or making a brief sound. `
               + `In this case FINISH the sentence/thought you were cut off in. `
               + `Say the part you had not said yet, in your own words, naturally - `
               + `do NOT restate anything you already said out loud, and do NOT `
               + `restart the whole answer from the beginning.\n`;
            p += `  (B) His words DID change the direction - a correction, a new `
               + `question, a new instruction, or "wait / actually / no". In this `
               + `case drop the unfinished line and say something NEW that answers `
               + `what he just said.\n`;
            p += `You are marked as INTERRUPTED for this turn. Pick (A) or (B) - `
               + `do not do both, and do not narrate which one you picked.\n`;
        } else {
            p += `user only made a brief sound (like "oh" or "hmm"), or interrupted `
               + `you without saying anything substantive. This is case (A): `
               + `continue the sentence/thought you were cut off in, right where `
               + `you stopped. Do NOT repeat what you already said, and do NOT `
               + `restart from the beginning.\n`;
        }
        p += `Keep it natural and spoken. One thought, then stop.\n`;
        return p;
    }
}

module.exports = {
    InterruptState,
    classifyInterruption,
    splitAckAndContent,
    norm,
    hasCJK,
    ACK_ONLY,
    REDIRECT_MARKERS,
};

const MAX_JOKES = 5;
const MAX_PREFS = 5;

class ConversationState {
    constructor() {
        this.topic = '';
        this.jokes = [];
        this.goal = '';
        this.prefs = [];
        this.turns = 0;
    }

    noteTurn(userText, replyText) {
        this.turns++;
        if (userText) {
            const t = String(userText).trim();
            if (t.length > 4) this.topic = t.slice(0, 120);
        }
        if (replyText) {
            const r = String(replyText);
            const quoted = r.match(/"([^"]{4,60})"/g) || [];
            for (const q of quoted.slice(0, 2)) {
                this._pushJoke(q.replace(/"/g, ''));
            }
        }
    }

    _pushJoke(text) {
        const t = String(text || '').trim();
        if (!t) return;
        if (this.jokes.some(j => j.text === t)) return;
        this.jokes.push({ text: t, at: Date.now() });
        while (this.jokes.length > MAX_JOKES) this.jokes.shift();
    }

    _pushPref(text) {
        const t = String(text || '').trim();
        if (!t) return;
        if (this.prefs.some(p => p.text === t)) return;
        this.prefs.push({ text: t, at: Date.now() });
        while (this.prefs.length > MAX_PREFS) this.prefs.shift();
    }

    setGoal(g) {
        this.goal = String(g || '').trim().slice(0, 120);
    }

    rememberPref(p) {
        this._pushPref(p);
    }

    rememberJoke(j) {
        this._pushJoke(j);
    }

    render() {
        if (!this.topic && !this.jokes.length && !this.goal && !this.prefs.length) {
            return '';
        }
        let out = '';
        if (this.topic) {
            out += `- Right now you and user are talking about: "${this.topic}"\n`;
        }
        if (this.goal) {
            out += `- The thing you are trying to do together: ${this.goal}\n`;
        }
        if (this.jokes.length) {
            out += '- Inside jokes / running bits you two share (you may pick these up '
                 + 'naturally, but do not force them):\n';
            for (const j of this.jokes) out += `  · ${j.text}\n`;
        }
        if (this.prefs.length) {
            out += '- Preferences of user you have noticed (use subtly, never recite them):\n';
            for (const p of this.prefs) out += `  · ${p.text}\n`;
        }
        return out;
    }

    toJSON() {
        return {
            topic: this.topic, goal: this.goal,
            jokes: this.jokes.map(j => j.text),
            prefs: this.prefs.map(p => p.text),
            turns: this.turns,
        };
    }
}

module.exports.ConversationState = ConversationState;
module.exports.MAX_JOKES = MAX_JOKES;
module.exports.MAX_PREFS = MAX_PREFS;
