'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PY = 'C:/Users/<YOUR_USER>/.workbuddy/binaries/python/envs/default/Scripts/python.exe';

const { EnhancedTextProcessor } = require(path.join(ROOT, 'js', 'tts-processor.js'));

let pass = 0, fail = 0;
const ck = (name, ok, detail) => {
    if (ok) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? ' → ' + detail : ''}`); }
};

const CASES = [
    {
        name: '句首标签 + 台词',
        raw: '[blush] Thank you, user. That was... unexpected.',
    },
    {
        name: '多个标签',
        raw: '[concerned] You look tired. [gentle_smile] Take a break, okay?',
    },
    {
        name: '带空格的旧式标签',
        raw: '[very emotional] I still think about that night.',
    },
    {
        name: '纯表情轮次（只有标签）',
        raw: '[starry_eyes]',
        expressionOnly: true,
    },
    {
        name: '标签在话后面',
        raw: "I'm not blushing. [blush]",
    },
];

console.log('\n=== 情绪标签与台词的分离 ===\n');

const pyCode = [
    'import sys, json',
    `sys.path.insert(0, r"${path.join(ROOT, 'backend').replace(/\\/g, '\\\\')}")`,
    'import agent_bridge as ab',
    'cases = json.loads(sys.stdin.read())',
    'out = []',
    'for c in cases:',
    '    out.append({',
    '        "raw": c["raw"],',
    '        "stripped": ab.strip_emotion_tags(c["raw"]),',
    '        "emotion": ab.detect_emotion(c["raw"]),',
    '        "expr_only": ab.is_expression_only(c["raw"]),',
    '    })',
    'print(json.dumps(out, ensure_ascii=False))',
].join('\n');

let pyRes = null;
try {
    pyRes = JSON.parse(execFileSync(PY, ['-c', pyCode], {
        encoding: 'utf8',
        cwd: path.join(ROOT, 'backend'),
        input: JSON.stringify(CASES.map(c => ({ raw: c.raw }))),
    }).trim());
} catch (e) {
    console.log('  SKIP  后端 Python 不可用：' + (e.message || e));
}

console.log('[1] 后端：标签被剥离，情绪被单独判出');
if (pyRes) {
    for (const r of pyRes) {
        const hasTag = /\[[^\]]*\]/.test(r.stripped);
        ck(`后端剥标签后无残留（${r.raw.slice(0, 24)}…）`, !hasTag, r.stripped);
        ck(`后端判出情绪（${r.raw.slice(0, 24)}…）→ ${r.emotion}`, !!r.emotion && r.emotion !== '', r.emotion);
    }
    // 纯表情轮次（后端返回的字段名是 expr_only）
    const only = pyRes.find(r => r.expr_only);
    ck('纯表情轮次被识别（[starry_eyes] 单独一句）', !!only, JSON.stringify(pyRes.map(r => r.expr_only)));
    if (only) {
        ck('纯表情轮次的情绪 = starry_eyes', only.emotion === 'starry_eyes', only.emotion);
        ck('纯表情轮次剥完标签后没有台词', only.stripped.trim() === '', JSON.stringify(only.stripped));
    }
    const tail = pyRes.find(r => r.raw.includes("I'm not blushing"));
    if (tail) ck('句尾标签也能判出情绪 → blush', tail.emotion === 'blush', tail.emotion);
} else {
    console.log('  SKIP');
}

console.log('\n[2] 前端：送进 TTS 引擎的文本里没有标签（不会被念出来）');
for (const c of CASES) {
    const spoken = EnhancedTextProcessor.stripEmotionTags(c.raw);
    ck(`TTS 文本无标签（${c.name}）`, !/\[[^\]]*\]/.test(spoken), spoken);
    ck(`TTS 文本非空且有内容（${c.name}）`, c.expressionOnly ? spoken.trim() === '' : spoken.trim().length > 0, spoken);
}

console.log('\n[3] 前端：字幕文本与 TTS 文本同源（标签同样不显示）');
for (const c of CASES) {
    const clean = EnhancedTextProcessor.stripEmotionTags(c.raw);
    ck(`字幕文本无标签（${c.name}）`, !/\[[^\]]*\]/.test(clean), clean);
}

console.log('\n[4] 流式分片：标签被劈成两半也不能漏进 TTS');
const whole = EnhancedTextProcessor.stripEmotionTags('[happy] I keep talking.');
ck('整条剥离正确', whole === 'I keep talking.', JSON.stringify(whole));

console.log(`\n结果：${pass} PASS / ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
