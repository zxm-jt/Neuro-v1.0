'use strict';

const EYE_BALL_Y_DOWN = -0.85;

const EXPRESSIONS = {
    neutral: {
        face: '中性放松', use: '回到默认状态；没有情绪可说的时候',
        params: {}, motion: 'Gentle', hold: 2600,
    },
    happy: {
        face: '开心的笑容', use: '快乐和积极反应',
        params: { bL: 1.20, bA: -0.40, eye: 3.20, eOpen: 1.20, mouth: 2.00, cheek: 2.20 },
        motion: 'Cheer', hold: 3200,
    },
    blush: {
        face: '脸颊泛红', use: '受到夸奖、被戳穿、有点不好意思',
        params: { bL: 0.60, bA: -0.30, bF: 0.30, eye: 1.20, mouth: 0.60, cheek: 4.20 },
        motion: 'Gentle', hold: 3200,
    },
    look_down: {
        face: '视线向下', use: '害羞、尴尬、被说中不想让你看',
        params: {
            bL: -0.40, bA: 0.30, bF: 0.20, eye: 0.40,
            ballY: EYE_BALL_Y_DOWN, angleY: -9, mouth: -0.60, cheek: 1.60, shoulder: 1.20,
        },
        motion: 'Gentle', hold: 3000,
    },
    starry_eyes: {
        face: '闪闪发光的星星眼', use: '兴奋、着迷、被你展示的东西击中',
        params: {
            bL: 2.20, bA: -0.80, bF: -0.30, eye: 2.60, eOpen: 3.20,
            mouth: 1.20, cheek: 3.00, angleZ: -6,
        },
        motion: 'Cheer', hold: 3200,
    },
    gentle_smile: {
        face: '温柔、令人安心的微笑', use: '安慰用户、缓和气氛、说软话',
        params: { bL: 0.20, bA: -0.20, bF: 0.60, eye: 1.00, mouth: 0.70, cheek: 0.80 },
        motion: 'Gentle', hold: 3600,
    },
    thoughtful: {
        face: '若有所思的表情', use: '哲学和学术讨论、在琢磨你的话',
        params: {
            bL: 0.40, bA: -0.20, bF: 0.20, eye: 0.40,
            ballX: 0.50, angleZ: 6, mouth: 0.10,
        },
        motion: 'Think', hold: 3400,
    },
    curious: {
        face: '感兴趣、好奇的表情', use: '提问、探索想法、想多知道一点',
        params: {
            bL: 1.80, bA: -0.90, bF: -0.20, eye: 0.80, eOpen: 2.00,
            ballX: -0.40, angleZ: -6, mouth: 0.40,
        },
        motion: 'Think', hold: 3000,
    },
    concerned: {
        face: '担忧的表情', use: '回应痛苦、听到坏消息、担心你',
        params: { bL: 0.90, bA: -0.60, bF: 0.50, eOpen: 2.40, mouth: -0.80 },
        motion: 'Think', hold: 3400,
    },

    playful: {
        face: '调皮、坏笑', use: '故意逗他、开玩笑、恶作剧',
        params: {
            bL: 1.40, bA: -0.60, bF: -0.50, eye: 2.60, eOpen: 1.80,
            mouth: 1.40, cheek: 2.60, angleZ: -8,
        },
        motion: 'Cheer', hold: 2800,
    },
    bored: {
        face: '无聊、提不起劲', use: '话题没意思、走神、懒得接话',
        params: {
            bL: -0.50, bA: -0.20, bF: 0.30, eye: 0.30, eOpen: 0.90,
            ballX: 0.60, angleY: 2, angleZ: 7, mouth: -0.20, cheek: 0.20,
        },
        motion: 'Gentle', hold: 3000,
    },

    joy: {
        face: '开心的笑容（更强烈）', use: '特别高兴、欢呼',
        params: { bL: 1.60, bA: -0.60, eye: 4.00, eOpen: 1.60, mouth: 2.60, cheek: 2.80 },
        motion: 'Cheer', hold: 3200,
    },
    excited: {
        face: '兴奋', use: '激动、迫不及待',
        params: {
            bL: 2.00, bA: -0.70, eye: 2.00, eOpen: 2.60,
            mouth: 1.60, cheek: 2.40, angleZ: -5,
        },
        motion: 'Cheer', hold: 3000,
    },
    smile: {
        face: '微笑', use: '普通的高兴/友好',
        params: { bL: 0.80, bA: -0.30, eye: 2.00, mouth: 1.40, cheek: 1.40 },
        motion: 'Cheer', hold: 3000,
    },
    love: {
        face: '喜欢、亲昵', use: '表达喜欢、心软',
        params: {
            bL: 0.60, bA: -0.50, bF: 0.20, eye: 3.60, eOpen: 0.80,
            mouth: 1.60, cheek: 4.00,
        },
        motion: 'Gentle', hold: 3600,
    },
    shy: {
        face: '害羞（脸红 + 低头）', use: '害羞、不好意思、被夸奖又躲不开',
        params: {
            bL: 0.20, bA: 0.20, bF: 0.30, eye: 0.80,
            ballY: EYE_BALL_Y_DOWN, angleY: -6, mouth: -0.20, cheek: 3.60, shoulder: 1.00,
        },
        motion: 'Gentle', hold: 3200,
    },
    sad: {
        face: '难过', use: '失落、想他、道歉',
        params: { bL: 0.50, bA: -0.50, bF: 0.40, eOpen: 1.80, mouth: -1.20 },
        motion: 'Sad', hold: 4200,
    },
    cry: {
        face: '哭', use: '委屈、忍不住',
        params: {
            bL: 0.90, bA: -0.60, bF: 0.50, eOpen: 0.60,
            mouth: -1.60, cheek: 1.00,
        },
        motion: 'Sad', hold: 4400,
    },
    confused: {
        face: '困惑', use: '没听懂、懵了',
        params: { bL: 0.50, bA: -0.30, bF: -0.50, eOpen: 3.20, mouth: -0.40 },
        motion: 'Think', hold: 3000,
    },
    thinking: {
        face: '若有所思', use: '思考、在权衡',
        params: { bL: 0.20, bA: -0.10, bF: 0.40, eye: 0.30, ballX: 0.40, angleZ: 5 },
        motion: 'Think', hold: 3400,
    },
    worried: {
        face: '担忧', use: '担心、紧张、不安',
        params: { bL: 0.80, bA: -0.50, bF: 0.40, eOpen: 2.60, mouth: -0.60 },
        motion: 'Think', hold: 3200,
    },
    shock: {
        face: '震惊', use: '惊到、说不出话',
        params: { bL: 2.40, bA: -0.30, bF: -0.40, eOpen: 6.00, mouth: -0.60 },
        motion: 'Think', hold: 2600,
    },
    surprised: {
        face: '惊讶', use: '意外、没想到',
        params: { bL: 2.00, bA: -0.20, eOpen: 5.50, mouth: 0.60 },
        motion: 'Cheer', hold: 2600,
    },
    angry: {
        face: '生气', use: '发火、不满',
        params: { bL: -1.00, bA: 1.20, bF: -1.00, eOpen: 3.20, mouth: -1.60 },
        motion: 'Angry', hold: 3000,
    },
    mad: {
        face: '暴怒', use: '真怒、气炸了',
        params: { bL: -1.00, bA: 1.60, bF: -1.00, eOpen: 2.80, mouth: -2.00 },
        motion: 'Angry', hold: 3000,
    },
    annoyed: {
        face: '不耐烦', use: '烦、嫌弃',
        params: { bL: -0.80, bA: 0.80, bF: -0.60, eOpen: 3.20, mouth: -1.00 },
        motion: 'Angry', hold: 2800,
    },
    jealous: {
        face: '吃醋', use: '酸了、有点在意别人',
        params: { bL: -0.60, bA: 0.90, bF: -0.50, eOpen: 3.40, mouth: -0.80 },
        motion: 'Angry', hold: 2800,
    },
    smug: {
        face: '得意', use: '傲娇、卖关子、"我早说了"',
        params: { bL: 0.40, bA: 0.50, bF: 0.20, eye: 1.60, mouth: 1.20, cheek: 0.60 },
        motion: 'Gentle', hold: 3000,
    },

    sleepy: {
        face: '困倦、半睁眼', use: '夜深了、犯困、眼皮打架、不想动',
        params: {
            bL: -0.60, bA: 0.10, bF: 0.40, eye: 0.20, eOpen: 0.75,
            ballY: -0.55, angleY: -6, mouth: -0.30, shoulder: 0.80,
        },
        motion: 'Gentle', hold: 3200,
    },
    dizzy: {
        face: '眩晕、晃神', use: '被绕晕、脑子转不过来、受打击后发懵',
        params: {
            bL: 0.80, bA: -0.20, bF: -0.40, eye: 0.30, eOpen: 3.00,
            ballX: -0.70, ballY: 0.45, angleZ: 14, angleY: -3, mouth: -0.70,
        },
        motion: 'Think', hold: 2800,
    },
    mischievous: {
        face: '调皮的坏笑', use: '小坏主意、故意逗你、使坏得逞',
        params: {
            bL: 0.90, bA: -0.75, bF: -0.75, eye: 1.80, eOpen: 1.30,
            ballX: 0.45, mouth: 2.20, cheek: 3.10, angleZ: -9,
        },
        motion: 'Cheer', hold: 2800,
    },
    proud: {
        face: '骄傲、抬头挺胸', use: '被认可、有成就感、"我厉害吧"',
        params: {
            bL: 2.40, bA: -0.35, bF: -0.10, eye: 3.40, eOpen: 0.50,
            angleY: 8, mouth: 1.80, cheek: 1.20, shoulder: 0.40,
        },
        motion: 'Gentle', hold: 3200,
    },
    relieved: {
        face: '松了一口气', use: '虚惊一场、终于放下心、危机解除',
        params: {
            bL: 0.30, bA: -0.15, bF: 1.20, eye: 1.40, eOpen: 1.00,
            mouth: 0.90, cheek: 1.00, shoulder: -0.60,
        },
        motion: 'Gentle', hold: 3600,
    },
    touched: {
        face: '感动、泪眼含笑', use: '被真心话打动、收到礼物、暖到心里',
        params: {
            bL: 1.10, bA: -0.65, bF: 0.35, eye: 3.00, eOpen: 2.60,
            ballY: -0.25, mouth: 1.60, cheek: 4.40, angleZ: -4,
        },
        motion: 'Gentle', hold: 4000,
    },
    scheming: {
        face: '谋划、眯眼打量', use: '心里有数、盘算着什么、冷静地算计',
        params: {
            bL: -0.20, bA: 0.55, bF: -0.65, eye: 0.60, eOpen: 1.10,
            ballX: -0.55, mouth: 1.30, cheek: 0.50, angleZ: 5,
        },
        motion: 'Think', hold: 3200,
    },
    trembling: {
        face: '发抖、强撑镇定', use: '吓到了、紧张到发颤、又怕又硬扛',
        params: {
            bL: 1.30, bA: -0.45, bF: -0.55, eOpen: 4.20,
            mouth: -1.40, cheek: 0.30, shoulder: 2.40, bodyX: 1.50,
        },
        motion: 'Sad', hold: 3400,
    },
    facepalm: {
        face: '扶额、没眼看', use: '被蠢哭、无奈、拿你没办法',
        params: {
            bL: -0.90, bA: 1.10, bF: -0.85, eOpen: 1.60,
            ballY: -0.65, angleY: -12, mouth: -1.30, shoulder: 1.60, angleZ: 4,
        },
        motion: 'Gentle', hold: 3000,
    },
    sparkle: {
        face: '灵光一闪、眼睛发亮', use: '突然想到好主意、眼前一亮、顿悟',
        params: {
            bL: 2.60, bA: -0.85, bF: -0.30, eye: 1.20, eOpen: 5.20,
            ballY: 0.65, mouth: 0.80, angleZ: -7,
        },
        motion: 'Cheer', hold: 2600,
    },
    content_squint: {
        face: '惬意眯眼笑', use: '舒服、满足、晒太阳、慢悠悠的幸福',
        params: {
            bL: 0.10, bA: -0.25, bF: 0.85, eye: 3.10, eOpen: 0.65,
            mouth: 1.50, cheek: 2.40, angleY: 4,
        },
        motion: 'Gentle', hold: 3800,
    },
    guilty: {
        face: '心虚、不敢对视', use: '愧疚、说谎被抓、觉得自己不对',
        params: {
            bL: -0.35, bA: -0.35, bF: 0.25, eye: 0.25, eOpen: 2.20,
            ballX: 0.75, ballY: -0.50, mouth: -0.90, cheek: 2.00, angleZ: -5,
        },
        motion: 'Think', hold: 2800,
    },
};


const PARAM_IDS = {
    bL: ['ParamBrowLY', 'ParamBrowRY'],
    bA: ['ParamBrowLAngle', 'ParamBrowRAngle'],
    bF: ['ParamBrowLForm', 'ParamBrowRForm'],
    eye: ['ParamEyeLSmile', 'ParamEyeRSmile'],
    eOpen: ['ParamEyeLOpen', 'ParamEyeROpen'],
    ballX: ['ParamEyeBallX'],
    ballY: ['ParamEyeBallY'],
    mouth: ['ParamMouthForm'],
    cheek: ['ParamCheek'],
    angleY: ['ParamAngleY'],
    angleZ: ['ParamAngleZ'],
    shoulder: ['ParamShoulder'],
    bodyX: ['ParamBodyAngleX'],
};


const ALL_PARAM_IDS = [
    'ParamBrowLY', 'ParamBrowRY',
    'ParamBrowLAngle', 'ParamBrowRAngle',
    'ParamBrowLForm', 'ParamBrowRForm',
    'ParamEyeLSmile', 'ParamEyeRSmile',
    'ParamEyeLOpen', 'ParamEyeROpen',
    'ParamEyeBallX', 'ParamEyeBallY',
    'ParamMouthForm', 'ParamCheek',
    'ParamAngleY', 'ParamAngleZ',
    'ParamShoulder', 'ParamBodyAngleX',
];


const EXPRESSION_KEYS = Object.keys(EXPRESSIONS);


function getExpression(key) {
    if (!key) return null;
    return EXPRESSIONS[key] || null;
}

function flattenParams(expr) {
    const out = {};
    if (!expr || !expr.params) return out;
    for (const field of Object.keys(PARAM_IDS)) {
        const v = expr.params[field];
        if (v === undefined || v === null) continue;
        const num = +v;
        if (!isFinite(num) || num === 0) continue;
        for (const id of PARAM_IDS[field]) out[id] = num;
    }
    return out;
}

const PARAM_RANGES = {
    ParamCheek: [0, 5.37],
    ParamEyeLOpen: [0, 7.07], ParamEyeROpen: [0, 7.07],
    ParamEyeLSmile: [0, 4.40], ParamEyeRSmile: [0, 4.40],
    ParamEyeBallX: [-1, 1], ParamEyeBallY: [-1, 1],
    ParamBrowLY: [-1, 4.67], ParamBrowRY: [-1, 4.67],
    ParamBrowLAngle: [-1, 8.57], ParamBrowRAngle: [-1, 8.57],
    ParamBrowLForm: [-1, 8.57], ParamBrowRForm: [-1, 8.57],
    ParamMouthForm: [-2, 6.63],
    ParamAngleY: [-30, 30], ParamAngleZ: [-30, 30],
    ParamShoulder: [-1, 5.37], ParamBodyAngleX: [-10, 10],
};

const MICRO_EXPRESSIONS = {
    blink:         { eOpen: -2.40 },
    slow_blink:    { eOpen: -1.20 },
    wide_eyes:     { eOpen: +2.20, bL: +0.50 },
    bright_pupil:  { ballY: +0.30, eOpen: +0.50 },
    blush_deep:    { cheek: +2.20 },
    brow_raise:    { bL: +0.90, bA: -0.20 },
    brow_furrow:   { bL: -0.50, bA: +0.50, bF: -0.50 },
    squint:        { eOpen: -1.00, eye: +1.20 },
    head_tilt:     { angleZ: -6 },
    glance_away:   { ballX: +0.55, ballY: EYE_BALL_Y_DOWN * 0.6 },
    chin_up:       { angleY: +5 },
    shoulder_lift: { shoulder: +1.40 },
};

const MICRO_BY_SIGNAL = {
    praised:    ['blush_deep', 'squint'],
    corrected:  ['glance_away', 'brow_furrow'],
    reunion:    ['bright_pupil', 'head_tilt'],
    idle_long:  ['slow_blink'],
    tool:       ['glance_away'],
};

function _clampParam(id, v) {
    const r = PARAM_RANGES[id];
    if (!r) return v;
    return Math.min(r[1], Math.max(r[0], v));
}

function _asFlatParams(base) {
    if (!base) return {};
    if (typeof base === 'string') return flattenParams(getExpression(base));
    if (base.params) return flattenParams(base);
    const out = {};
    for (const id of Object.keys(base)) {
        const v = +base[id];
        if (isFinite(v)) out[id] = v;
    }
    return out;
}

function blendExpressions(base, modifiers, weight) {
    const out = _asFlatParams(base);
    const w = (typeof weight === 'number' && isFinite(weight))
        ? Math.min(1, Math.max(0, weight)) : 0.5;
    let list = modifiers;
    if (!Array.isArray(list)) list = (list == null) ? [] : [list];

    const addFieldDelta = (fields, scale) => {
        for (const field of Object.keys(fields)) {
            const ids = PARAM_IDS[field];
            const d = +fields[field];
            if (!ids || !isFinite(d)) continue;
            for (const id of ids) out[id] = _clampParam(id, (out[id] || 0) + d * scale);
        }
    };

    for (const mod of list) {
        if (!mod) continue;
        if (typeof mod === 'string') {
            const micro = MICRO_EXPRESSIONS[mod];
            if (micro) {
                addFieldDelta(micro, w);
            } else {
                const target = flattenParams(getExpression(mod));
                for (const id of Object.keys(target)) {
                    const from = out[id] || 0;
                    out[id] = _clampParam(id, from + (target[id] - from) * w);
                }
            }
        } else if (typeof mod === 'object') {
            const looksFlat = Object.keys(mod).some((k) => k.indexOf('Param') === 0);
            if (looksFlat) {
                for (const id of Object.keys(mod)) {
                    const d = +mod[id];
                    if (isFinite(d)) out[id] = _clampParam(id, (out[id] || 0) + d * w);
                }
            } else {
                addFieldDelta(mod, w);
            }
        }
    }
    return out;
}


function microForSignal(signal) {
    if (!signal) return null;
    const s = String(signal).toLowerCase().trim();
    return MICRO_BY_SIGNAL[s] || null;
}

module.exports = {
    EXPRESSIONS,
    EXPRESSION_KEYS,
    PARAM_IDS,
    ALL_PARAM_IDS,
    EYE_BALL_Y_DOWN,
    PARAM_RANGES,
    MICRO_EXPRESSIONS,
    MICRO_BY_SIGNAL,
    getExpression,
    flattenParams,
    blendExpressions,
    microForSignal,
};
