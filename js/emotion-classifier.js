'use strict';

const { EXPRESSION_KEYS } = require('./expression-map.js');

const LEX = {
    happy: [
        ['(太好啦|好耶|耶[!！]|太棒了|好开心|开心极|哈哈[哈]*|嘻嘻|嘿嘿|呵呵[呵]*|笑出声)', 1.3],
        ['(开心|高兴|快乐|欢喜|欣喜|乐)', 1.0],
        ['\\bhaha\\b|\\bhehe\\b|\\blol\\b|\\byay\\b', 0.6],
        ['\\bglad\\b|\\bdelighted\\b|\\bcheerful\\b|\\bwonderful\\b|\\bfantastic\\b|\\bawesome\\b|\\bamazing\\b|\\bgreat\\b', 0.8],
    ],
    joy: [
        ['(超开心|欣喜|雀跃|欢喜雀跃|开心得)', 1.3],
        ['\\boverjoyed\\b|\\becstatic\\b|\\bbeaming\\b|\\bcan\'t stop smiling\\b', 1.0],
        ['\\bso happy\\b|\\bthrilled\\b', 0.8],
    ],
    excited: [
        ['(激动|兴奋|冲鸭|冲冲冲|等不及|迫不及待|好兴奋)', 1.3],
        ['\\bexcited\\b|\\bexciting\\b', 1.0],
        ['\\bcan\'t wait\\b|\\bpumped\\b|\\bhyped\\b|\\bstoked\\b|\\bwoohoo\\b|\\byes!\\b', 0.9],
    ],
    smile: [
        ['(微笑|微微一笑|抿嘴笑|笑了)', 1.0],
        ['\\bsmile\\b|\\bgrin\\b|\\bchuckle\\b', 0.8],
    ],
    starry_eyes: [
        ['(星星眼|闪闪发光|看呆|心动|着迷|移不开眼)', 1.3],
        ['\\bstarry\\b|\\bsparkl\\w*\\b|\\bshiny\\b|\\bmesmeriz\\w*\\b|\\bcaptivated\\b|\\binfatuated\\b', 1.0],
    ],
    surprised: [
        ['(不会吧|真的吗|天哪|哇哦|居然|没想到|竟[然然]|什么鬼)', 1.3],
        ['\\bomg\\b|\\bwtf\\b|\\bno way\\b|\\bunbelievable\\b|\\bwhoah?\\b|\\bwow\\b', 1.0],
        ['\\breally\\?\\b|\\bwhat\\?\\b', 0.8],
    ],
    shock: [
        ['(震惊|惊呆|石化|说不出话|目瞪口呆|傻了)', 1.3],
        ['\\bshocked\\b|\\bspeechless\\b|\\bmind[- ]?blown\\b|\\bjaw dropped\\b|\\bfrozen\\b', 1.1],
    ],
    gentle_smile: [
        ['(温柔|安心|别怕|没事|乖|摸头|别担心)', 1.2],
        ['\\bgentle\\b|\\bsooth\\w*\\b|\\breassur\\w*\\b|\\bcalm down\\b|\\bit\'s okay\\b|\\bthere there\\b', 1.0],
    ],
    blush: [
        ['(脸红|泛红|羞红|脸颊发烫)', 1.3],
        ['\\bblush\\b|\\bflushed\\b|\\bmy cheeks\\b|\\bred-faced\\b', 1.0],
    ],
    look_down: [
        ['(低头|垂眸|移开视线|不敢看|别看我|躲开目光)', 1.3],
        ['\\blook away\\b|\\bavert\\w*\\b|\\bdowncast\\b|\\beyes lowered\\b', 1.0],
    ],
    shy: [
        ['(害羞|不好意思|难为情|羞涩|躲起来)', 1.3],
        ['\\bshy\\b|\\bembarrassed\\b|\\bbashful\\b|\\bcoy\\b|\\bflustered\\b', 1.0],
    ],
    love: [
        ['(喜欢你|心软|好喜欢|爱死|亲昵|心疼你)', 1.3],
        ['\\blove you\\b|\\badore\\b|\\baffection\\b|\\bmy heart\\b|\\bsweetheart\\b|\\bdear\\b', 1.1],
    ],
    bored: [
        ['(无聊|没意思|提不起劲|敷衍|好闲|犯困)', 1.2],
        ['\\bbored\\b|\\bboring\\b|\\bmeh\\b|\\bwhatever\\b|\\btune out\\b|\\bzzz\\b', 1.0],
    ],
    smug: [
        ['(得意|傲娇|哼|早就说了|我说的吧)', 1.3],
        ['\\bsmug\\b|\\bproud\\b|\\btold you\\b|\\bknow-it-all\\b|\\bcheeky\\b|\\bsmirk\\b', 1.0],
    ],
    playful: [
        ['(调皮|恶作剧|逗你|开玩笑|使坏|坏笑|逗我)', 1.3],
        ['\\bplayful\\b|\\bteas\\w*\\b|\\bjust kidding\\b|\\bkidding\\b|\\bprank\\b|\\bsilly\\b|\\blalala\\b|\\bmischief\\b|\\bgotcha\\b', 1.0],
    ],
    thoughtful: [
        ['(若有所思|琢磨|沉思|思考中|嗯…|让我想想)', 1.3],
        ['\\bthoughtful\\b|\\bhmm\\b|\\bponder\\w*\\b|\\bmusing\\b|\\breflect\\w*\\b|\\blet me think\\b|\\bconsider\\w*\\b', 1.0],
    ],
    thinking: [
        ['(想一下|权衡|分析|盘算|理一理)', 1.1],
        ['\\bthinking\\b|\\bthink about\\b|\\bweigh\\b|\\banalyz\\w*\\b|\\bfigure\\w* out\\b', 0.9],
    ],
    curious: [
        ['(好奇|感兴趣|想知道|探究|什么情况)', 1.2],
        ['\\bcurious\\b|\\binterested\\b|\\bwonder\\w*\\b|\\btell me more\\b|\\bwhat about\\b|\\bintrigu\\w*\\b', 1.0],
    ],
    concerned: [
        ['(担忧你|心疼|关切|担心地|你没事吧)', 1.3],
        ['\\bconcerned\\b|\\bcaring\\b|\\bworried about you\\b|\\bare you okay\\b|\\bhope you\'re\\b', 1.0],
    ],
    worried: [
        ['(担心|紧张|不安|怕|心里发毛|悬着)', 1.2],
        ['\\bworried\\b|\\banxious\\b|\\bnervous\\b|\\bscared\\b|\\bafraid\\b|\\buneasy\\b', 0.9],
    ],
    confused: [
        ['(困惑|不懂|懵|迷糊|没搞懂|绕晕)', 1.3],
        ['\\bconfused\\b|\\bpuzzl\\w*\\b|\\blost\\b|\\bwhat do you mean\\b|\\bhuh\\?\\b', 1.0],
    ],
    sad: [
        ['(难过|伤心|失落|想哭|寂寞|低落|提不起)', 1.3],
        ['\\bsad\\b|\\bdown\\b|\\bblue\\b|\\bmiss you\\b|\\blonely\\b|\\bgloomy\\b', 1.0],
    ],
    cry: [
        ['(哭了|委屈|流泪|忍不住|鼻子酸|想哭出来)', 1.3],
        ['\\bcry\\b|\\btears\\b|\\bsob\\w*\\b|\\bweep\\b|\\bbawl\\b', 1.0],
    ],
    angry: [
        ['(生气|愤怒|气死|烦死|讨厌|滚开|混蛋|闭嘴)', 1.3],
        ['\\banger\\b|\\bfurious\\b|\\bpissed\\b|\\bhate\\b|\\bannoy\\w*\\b|\\bstupid\\b|\\bidiot\\b', 1.0],
        ['\\bshut up\\b|\\bgo away\\b|\\bhell no\\b|\\bforget it\\b|\\bstop it\\b', 1.1],
    ],
    mad: [
        ['(暴怒|气炸|怒火|火大|气得)', 1.3],
        ['\\bmad\\b|\\benraged\\b|\\blivid\\b|\\brage\\b|\\bfuming\\b|\\bexplode\\b', 1.0],
    ],
    annoyed: [
        ['(不耐烦|嫌弃|啰嗦|烦人|够了)', 1.2],
        ['\\bannoyed\\b|\\birritated\\b|\\bvexed\\b|\\bgrumpy\\b|\\bugh\\b|\\beye-roll\\b', 1.0],
    ],
    jealous: [
        ['(吃醋|酸了|在意别人|嫉妒|心里不是滋味)', 1.3],
        ['\\bjealous\\b|\\benvy\\b|\\bgreen-eyed\\b', 1.0],
    ],

    sleepy: [
        ['(困了|困倦|好困|想睡|瞌睡|眼皮沉|熬夜了|哈欠)', 1.2],
        ['\\bsleepy\\b|\\bdrowsy\\b|\\bsomnolent\\b|\\bsleepyhead\\b', 1.0],
    ],
    dizzy: [
        ['(头晕|眩晕|晕了|晕乎乎|天旋地转|转晕|脑子乱)', 1.3],
        ['\\bdizzy\\b|\\bvertigo\\b|\\bgiddy\\b|\\blightheaded\\b', 1.0],
    ],
    mischievous: [
        ['(坏笑|使坏|捉弄|小坏|调皮捣蛋|恶作剧得逞|坏主意)', 1.2],
        ['\\bmischievous\\b|\\bwily\\b|\\bimpish\\b|\\bup to no good\\b', 1.0],
    ],
    proud: [
        ['(骄傲|自豪|得意洋洋|真了不起|干得漂亮我|有面子)', 1.2],
        ['\\bproud\\b|\\bhonored\\b|\\baccomplished\\b', 1.0],
    ],
    relieved: [
        ['(松口气|松了口气|放下心|总算好了|终于没事|还好|虚惊)', 1.2],
        ['\\brelieved\\b|\\brelief\\b|\\bphew\\b', 1.0],
    ],
    touched: [
        ['(感动|泪目|好感动|暖到了|被你感动|眼眶湿)', 1.3],
        ['\\btouched\\b|\\bmoved to tears\\b|\\bteary-eyed\\b', 1.0],
    ],
    scheming: [
        ['(谋划|盘算着|算计|心中有数|暗自打算|计划通)', 1.2],
        ['\\bscheming\\b|\\bplotting\\b|\\bconniving\\b', 1.0],
    ],
    trembling: [
        ['(发抖|颤抖|瑟瑟发抖|吓得|哆嗦|抖成)', 1.3],
        ['\\btrembl\\w*\\b|\\bshiver\\w*\\b|\\bquiver\\w*\\b', 1.0],
    ],
    facepalm: [
        ['(扶额|捂脸|我服了|没眼看|拿你没办法|真拿你没辙)', 1.3],
        ['\\bfacepalm\\b|\\bsmh\\b|\\bhead desk\\b', 1.0],
    ],
    sparkle: [
        ['(灵光一闪|有主意了|想到了|眼前一亮|亮了|顿悟)', 1.3],
        ['\\bepiphany\\b|\\baha moment\\b|\\bspark of inspiration\\b', 1.0],
    ],
    content_squint: [
        ['(惬意|舒服|满足地笑|眯眼笑|晒太阳|慢悠悠)', 1.2],
        ['\\bcontented\\b|\\bcozy\\b|\\bcosy\\b', 0.9],
    ],
    guilty: [
        ['(心虚|内疚|愧疚|是我不好|不敢看你|对不起你)', 1.3],
        ['\\bguilty\\b|\\bashamed\\b|\\bremorseful\\b', 1.0],
    ],
};

const NEG_RE = /(?:not|never|no|don'?t|can'?t|won'?t|isn'?t|aren'?t|hardly|without|不|没|别|莫|勿)\s+(?:\S+\s+){0,1}$/i;

const NEUTRAL_THRESHOLD = 0.8;

const SOFT_POOL = [
    'gentle_smile', 'smile', 'thoughtful', 'thinking', 'curious',
    'smug', 'playful', 'blush', 'look_down', 'bored', 'love',
    'concerned', 'confused', 'surprised', 'starry_eyes', 'shy',
];

const SOFT_SURPRISE_P = 0.42;

const SIGNAL_POOLS = {
    praised:    ['touched', 'proud', 'blush', 'relieved', 'content_squint', 'sparkle'],
    corrected:  ['facepalm', 'guilty', 'trembling', 'look_down', 'concerned', 'dizzy'],
    reunion:    ['touched', 'sparkle', 'starry_eyes', 'happy', 'excited', 'content_squint'],
    idle_long:  ['sleepy', 'bored', 'content_squint', 'dizzy', 'thoughtful', 'look_down'],
    tool:       ['scheming', 'curious', 'thinking', 'sparkle', 'mischievous', 'dizzy'],
};


const SIGNAL_ALIAS = {
    just_praised: 'praised', compliment: 'praised', praise: 'praised', '被夸': 'praised',
    just_corrected: 'corrected', criticized: 'corrected', correction: 'corrected', '被纠正': 'corrected',
    long_absence: 'reunion', reunited: 'reunion', long_time_no_see: 'reunion', '久别重逢': 'reunion',
    idle: 'idle_long', long_idle: 'idle_long', '长时间空闲': 'idle_long',
    tool_running: 'tool', executing_tool: 'tool', '正在执行工具': 'tool',
};

function _resolveSignal(signal) {
    if (!signal) return null;
    const s = String(signal).toLowerCase().trim();
    if (SIGNAL_POOLS[s]) return s;
    return SIGNAL_ALIAS[s] || null;
}

function _pickFrom(pool, rng) {
    return pool[Math.floor(rng() * pool.length)];
}

function _toneFallback(clean, rng, signal) {
    const sig = _resolveSignal(signal);
    if (sig) return _pickFrom(SIGNAL_POOLS[sig], rng);

    const q = /[?？]\s*$/.test(clean);
    const bang = (clean.match(/[!！]/g) || []).length;
    const ell = /(\.{3}|…|\.\.\.)/.test(clean);
    const words = clean.trim().split(/\s+/).filter(Boolean).length;
    if (q) return (rng() < 0.5) ? 'curious' : 'thinking';
    if (bang >= 1) return (rng() < 0.5) ? 'surprised' : 'excited';
    if (ell) return (rng() < 0.6) ? 'thoughtful' : 'sad';
    if (words <= 3) return (rng() < 0.6) ? 'smile' : 'bored';
    
    if (rng() < SOFT_SURPRISE_P) return _pickFrom(SOFT_POOL, rng);
    return 'neutral';
}

function _stripTags(s) {
    return String(s).replace(/[\\[【]\\s*[A-Za-z0-9_\\u4e00-\\u9fff \\-\\u2010-\\u2015]{1,40}?\\s*[\\]】]/g, '');
}

function classify(text, opts) {
    const rng = (opts && typeof opts.rng === 'function') ? opts.rng : Math.random;
    const signal = opts && opts.signal;
    const clean = _stripTags(text || '');
    const low = clean.toLowerCase();
    const scores = {};
    for (const k of EXPRESSION_KEYS) scores[k] = 0;

    for (const key of EXPRESSION_KEYS) {
        const dict = LEX[key];
        if (!dict) continue;
        for (const entry of dict) {
            const src = entry[0];
            const w = entry[1];
            let re;
            try { re = new RegExp(src, 'gi'); } catch (e) { continue; }
            let m;
            let guard = 0;
            while ((m = re.exec(low)) !== null) {
                if (++guard > 200) break;
                let weight = w;
                const before = low.slice(Math.max(0, m.index - 25), m.index);
                if (NEG_RE.test(before)) weight *= 0.3;
                scores[key] += weight;
                if (m.index === re.lastIndex) re.lastIndex++;
            }
        }
    }

    const bang = (clean.match(/[!！]/g) || []).length;
    const q = (clean.match(/[?？]/g) || []).length;
    const ell = /(\.{3}|…|\.\.\.)/.test(clean);
    const shout = /[A-Z]{4,}/.test(clean);
    if (bang >= 2) { scores.happy += 1.0; scores.excited += 0.6; }
    if (bang >= 3 || shout) { scores.angry += 1.6; }
    if (q >= 1 && bang === 0) { scores.thinking += 0.5; scores.curious += 0.4; }
    if (ell) { scores.thoughtful += 0.5; scores.sad += 0.3; }

    let bestKey = 'neutral', best = 0, second = 0;
    for (const k of EXPRESSION_KEYS) {
        if (k === 'neutral') continue;
        if (scores[k] > best) { second = best; best = scores[k]; bestKey = k; }
        else if (scores[k] > second) { second = scores[k]; }
    }
    const confidence = best > 0 ? best / (best + second + 0.001) : 0;
    const strong = best >= NEUTRAL_THRESHOLD;
    const key = strong ? bestKey : _toneFallback(clean, rng, signal);
    return { key, score: best, scores, confidence, strong };
}


function pick(text, opts) {
    return classify(text, opts).key;
}

function judge(text, opts) {
    return classify(text, opts).key;
}

module.exports = { LEX, NEG_RE, NEUTRAL_THRESHOLD, SOFT_POOL, SOFT_SURPRISE_P,
    SIGNAL_POOLS, SIGNAL_ALIAS, classify, pick, judge };
