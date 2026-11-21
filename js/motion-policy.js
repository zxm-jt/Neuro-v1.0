'use strict';

const MOTION_BIAS = {
    neutral: 0.0,
    happy: 0.85, joy: 0.90, excited: 0.90, smile: 0.60, starry_eyes: 0.80,
    playful: 0.75, surprised: 0.60, shock: 0.50,
    sad: 0.80, cry: 0.85, angry: 0.90, mad: 0.95, annoyed: 0.75, jealous: 0.70,
    gentle_smile: 0.45, love: 0.45, blush: 0.35, shy: 0.35, look_down: 0.30, smug: 0.45,
    thoughtful: 0.12, thinking: 0.12, curious: 0.18, concerned: 0.22,
    worried: 0.22, confused: 0.18, bored: 0.18,
    sleepy: 0.15, dizzy: 0.35, mischievous: 0.70, proud: 0.50, relieved: 0.35, touched: 0.55,
    scheming: 0.40, trembling: 0.55, facepalm: 0.45, sparkle: 0.60,
    content_squint: 0.30, guilty: 0.25,
};


const ACCIDENT_P = 0.12;

function planMotion(key, opts) {
    opts = opts || {};
    const bias = opts.bias || MOTION_BIAS;
    const accidentP = (opts.accidentP != null) ? opts.accidentP : ACCIDENT_P;
    const rng = (typeof opts.rng === 'function') ? opts.rng : Math.random;
    const lastKey = (opts.lastKey != null) ? opts.lastKey : null;
    const avail = Array.isArray(opts.availableGroups) ? opts.availableGroups : [];

    const k = key || 'neutral';
    const changed = (k !== lastKey);

    if (!changed) return { play: false, group: null, changed: false, reason: 'same' };
    if (k === 'neutral') return { play: false, group: null, changed: true, reason: 'neutral' };

    const b = (bias[k] != null) ? bias[k] : 0.5;
    const play = rng() < b;
    if (!play) return { play: false, group: null, changed: true, reason: 'bias-skip' };

    let group = opts.canonicalGroup || null;
    if (avail.length && rng() < accidentP) {
        group = avail[Math.floor(rng() * avail.length)];
    }
    const reason = (group && group === opts.canonicalGroup) ? 'canonical' : 'accident';
    return { play: true, group, changed: true, reason };
}

module.exports = { MOTION_BIAS, ACCIDENT_P, planMotion };
