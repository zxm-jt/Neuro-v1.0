'use strict';

const { EXPRESSION_KEYS } = require('./expression-map.js');

const CANONICAL = EXPRESSION_KEYS.slice();

const ALIAS = {
    cheerful: 'happy', gladly: 'happy', happiness: 'happy', glad: 'happy',
    delight: 'happy', delighted: 'happy', pleasing: 'happy', pleased: 'happy',
    glee: 'joy', gleeful: 'joy', joyful: 'joy', enjoy: 'joy', enjoying: 'joy',
    excitement: 'excited', thrilling: 'excited', hyped: 'excited',
    stoked: 'excited', pumped: 'excited', eager: 'excited', zest: 'excited',
    smiley: 'smile', smiling: 'smile', grin: 'smile', grinning: 'smile',
    lovely: 'love', adore: 'love', adoring: 'love', loving: 'love',
    affection: 'love', fond: 'love', crush: 'love',
    shyness: 'shy', embarrassed: 'shy', embarrassing: 'shy', bashful: 'shy',
    blush: 'blush', blushing: 'blush', blushingly: 'blush', flushed: 'blush',
    red: 'blush', rosy: 'blush',
    look_down: 'look_down', lookdown: 'look_down', look_down_eyes: 'look_down',
    downcast: 'look_down', averting: 'look_down', avoiding_eye_contact: 'look_down',
    starry_eyes: 'starry_eyes', starryeyes: 'starry_eyes', starry: 'starry_eyes',
    sparkling: 'starry_eyes', sparkly: 'starry_eyes', shiny_eyes: 'starry_eyes',
    star_eyes: 'starry_eyes', infatuated: 'starry_eyes', mesmerized: 'starry_eyes',
    gentle_smile: 'gentle_smile', gentlesmile: 'gentle_smile', gentle: 'gentle_smile',
    soft_smile: 'gentle_smile', warm_smile: 'gentle_smile', soothing: 'gentle_smile',
    reassuring: 'gentle_smile', tender: 'gentle_smile',
    thoughtful: 'thoughtful', pensive: 'thoughtful', reflective: 'thoughtful',
    musing: 'thoughtful', contemplative: 'thoughtful', philosophical: 'thoughtful',
    reflect: 'thoughtful',
    curious: 'curious', curiosity: 'curious', inquisitive: 'curious',
    intrigued: 'curious', wondering: 'curious', curiosity_pique: 'curious',
    sadness: 'sad', unhappy: 'sad', down: 'sad', gloomy: 'sad',
    melancholy: 'sad', blue: 'sad', heartbroken: 'sad',
    crying: 'cry', tears: 'cry', teary: 'cry', sobbing: 'cry', weep: 'cry',
    confuse: 'confused', confusing: 'confused', puzzled: 'confused',
    puzzling: 'confused', bewildered: 'confused', lost: 'confused',
    think: 'thinking', pondering: 'thinking',
    worry: 'worried', worrying: 'worried', anxious: 'worried',
    anxiety: 'worried', nervous: 'worried', scared: 'worried',
    afraid: 'worried', fear: 'worried', fearful: 'worried', uneasy: 'worried',
    concerned: 'concerned', concern: 'concerned', caring: 'concerned',
    sympathetic: 'concerned', empathetic: 'concerned', worried_about_you: 'concerned',
    playful: 'playful', tease: 'playful', teasing: 'playful', teased: 'playful',
    mischievous: 'mischievous', impish: 'mischievous',
    silly: 'playful', goofy: 'playful',
    prankish: 'playful', joking: 'playful', jokey: 'playful', kid: 'playful',
    lalala: 'playful', la_la_la: 'playful',
    bored: 'bored', boredom: 'bored', disinterested: 'bored', indifferent: 'bored',
    apathetic: 'bored', listless: 'bored', meh: 'bored', unmotivated: 'bored',
    shocking: 'shock', shocked: 'shock', astonish: 'surprised',
    astonished: 'surprised', surprise: 'surprised', surprising: 'surprised',
    amazed: 'surprised', amazing: 'surprised', astounded: 'surprised',
    startle: 'surprised', startled: 'surprised',
    anger: 'angry', angrily: 'angry', furious: 'angry', fury: 'angry',
    rage: 'angry', irate: 'angry', livid: 'angry', cross: 'angry',
    madly: 'mad', madness: 'mad',
    annoyance: 'annoyed', annoying: 'annoyed', irritated: 'annoyed',
    irritating: 'annoyed', grumpy: 'annoyed', vexed: 'annoyed',
    jealousy: 'jealous', envy: 'jealous', envious: 'jealous',
    smugness: 'smug', proud: 'proud', conceited: 'smug',
    arrogant: 'smug', cheeky: 'smug', smirking: 'smug',

    sleepy: 'sleepy', drowsy: 'sleepy', sleepiness: 'sleepy', sleephead: 'sleepy',
    dizzy: 'dizzy', giddy: 'dizzy', vertigo: 'dizzy', lightheaded: 'dizzy',
    relieved: 'relieved', relief: 'relieved', phew: 'relieved',
    touched: 'touched', teary_eyed: 'touched',
    scheming: 'scheming', plotting: 'scheming', conniving: 'scheming',
    trembling: 'trembling', tremble: 'trembling', shivering: 'trembling', shiver: 'trembling',
    facepalm: 'facepalm',
    sparkle: 'sparkle', epiphany: 'sparkle', aha: 'sparkle',
    content_squint: 'content_squint', contented: 'content_squint', cozy: 'content_squint', cosy: 'content_squint',
    guilty: 'guilty', ashamed: 'guilty', remorseful: 'guilty',
    normal: 'neutral', calm: 'neutral', relaxed: 'neutral', default: 'neutral',
    '开心': 'happy', '高兴': 'happy', '快乐': 'happy', '喜': 'happy',
    '兴奋': 'excited', '激动': 'excited', '冲': 'excited',
    '喜欢': 'love', '爱': 'love', '可爱': 'love',
    '害羞': 'shy', '尴尬': 'shy',
    '脸红': 'blush', '泛红': 'blush', '羞红': 'blush',
    '低头': 'look_down', '垂眸': 'look_down', '移开视线': 'look_down',
    '星星眼': 'starry_eyes', '星星': 'starry_eyes', '闪闪发光': 'starry_eyes',
    '温柔': 'gentle_smile', '微笑': 'gentle_smile', '安心': 'gentle_smile',
    '思考': 'thinking', '想': 'thinking', '琢磨': 'thinking',
    '若有所思': 'thoughtful', '沉思': 'thoughtful',
    '好奇': 'curious', '感兴趣': 'curious', '探究': 'curious',
    '难过': 'sad', '伤心': 'sad', '不开心': 'sad', '低落': 'sad',
    '哭': 'cry', '委屈': 'cry', '想哭': 'cry',
    '困惑': 'confused', '不懂': 'confused', '迷茫': 'confused',
    '担心': 'worried', '害怕': 'worried', '紧张': 'worried', '怕': 'worried',
    '担忧': 'concerned', '关切': 'concerned', '心疼': 'concerned',
    '调皮': 'playful', '恶作剧': 'playful', '顽皮': 'playful',
    '开玩笑': 'playful', '逗你': 'playful',
    '无聊': 'bored', '没劲': 'bored', '没意思': 'bored', '提不起劲': 'bored',
    '震惊': 'surprised', '惊讶': 'surprised', '居然': 'surprised',
    '生气': 'angry', '愤怒': 'angry', '气死': 'angry', '气': 'angry',
    '烦': 'annoyed', '烦人': 'annoyed', '受不了': 'annoyed',
    '嫉妒': 'jealous', '酸': 'jealous',
    '得意': 'smug', '傲娇': 'smug',
    '困': 'sleepy', '困了': 'sleepy', '好困': 'sleepy', '犯困': 'sleepy', '困倦': 'sleepy',
    '头晕': 'dizzy', '眩晕': 'dizzy', '晕了': 'dizzy', '晕乎乎': 'dizzy',
    '坏笑': 'mischievous', '使坏': 'mischievous', '小坏': 'mischievous',
    '骄傲': 'proud', '自豪': 'proud', '得意洋洋': 'proud',
    '松口气': 'relieved', '松了口气': 'relieved', '放下心': 'relieved',
    '感动': 'touched', '泪目': 'touched',
    '谋划': 'scheming', '盘算': 'scheming', '算计': 'scheming',
    '发抖': 'trembling', '颤抖': 'trembling', '哆嗦': 'trembling',
    '扶额': 'facepalm', '捂脸': 'facepalm', '没眼看': 'facepalm',
    '灵光一闪': 'sparkle', '眼前一亮': 'sparkle', '顿悟': 'sparkle',
    '惬意': 'content_squint', '舒服': 'content_squint', '眯眼笑': 'content_squint',
    '心虚': 'guilty', '内疚': 'guilty', '愧疚': 'guilty',
};


const SUFFIXES = ['ness', 'ing', 'ful', 'ily', 'ed', 'ly', 'y', 'er', 's'];


function normalizeEmotionKey(raw) {
    if (!raw) return null;
    let key = String(raw).trim().toLowerCase()
        .replace(/^[\[【\s]+/, '').replace(/[\]】\s]+$/, '')
        .replace(/[\s\-]+/g, '_');
    if (!key) return null;

    if (CANONICAL.indexOf(key) >= 0) return key;
    if (ALIAS[key]) return ALIAS[key];
    const stems = [];
    for (const suf of SUFFIXES) {
        if (key.length > suf.length + 2 && key.endsWith(suf)) {
            stems.push(key.slice(0, -suf.length));
        }
    }
    for (const stem of stems) {
        if (CANONICAL.indexOf(stem) >= 0) return stem;
        if (ALIAS[stem]) return ALIAS[stem];
    }
    const prefixCandidates = [key].concat(stems);
    for (const cand of prefixCandidates) {
        if (cand.length < 3) continue;
        for (const c of CANONICAL) {
            if (c.indexOf(cand) === 0 || cand.indexOf(c) === 0) return c;
        }
    }
    return null;
}

function pickFallbackGroup(definitions, exclude) {
    if (!definitions || typeof definitions !== 'object') return null;
    const names = Object.keys(definitions).filter(
        (g) => Array.isArray(definitions[g]) && definitions[g].length > 0
            && g !== exclude && g !== 'Idle');
    if (!names.length) {
        const all = Object.keys(definitions).filter(
            (g) => Array.isArray(definitions[g]) && definitions[g].length > 0);
        return all.length ? all[Math.floor(Math.random() * all.length)] : null;
    }
    return names[Math.floor(Math.random() * names.length)];
}

module.exports = { CANONICAL, ALIAS, SUFFIXES, normalizeEmotionKey, pickFallbackGroup };
