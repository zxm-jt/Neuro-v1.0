#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const ROOT = path.dirname(__dirname);

let PASS = 0, FAIL = 0;
function ck(name, cond, detail = '') {
    if (cond) { PASS++; console.log(`  PASS  ${name}`); }
    else { FAIL++; console.log(`  FAIL  ${name}  ${detail}`); }
}

console.log('[1] 提示词三段规则在位');
{
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const sp = cfg.llm.system_prompt;
    if (!sp || sp.length < 500 || sp.includes('此处原本是')) {
        console.log('  SKIP  开源版 system_prompt 未填写人格，跳过提示词段落断言');
    } else {
    ck('有简短度段（CONVERSATIONAL BREVITY / RHYTHM & BREVITY）',
        sp.includes('CONVERSATIONAL BREVITY') || sp.includes('RHYTHM & BREVITY'));
    ck('有幽默段（NATURAL HUMOUR / HUMOUR）',
        sp.includes('NATURAL HUMOUR') || sp.includes('【HUMOUR】'));
    ck('有长度/节奏段（LENGTH & STYLE / REPLY LENGTH / LIVE CONVERSATION RHYTHM）',
        sp.includes('LENGTH & STYLE') || sp.includes('REPLY LENGTH')
        || sp.includes('LIVE CONVERSATION RHYTHM'));
    ck('要求简单反应通常一句',
        sp.includes('a simple reaction is one sentence') || sp.includes('should usually be one sentence'));
    ck('要求闲聊 1~3 句', sp.includes('one to three short sentences'));
    ck('要求别解释笑话',
        sp.includes('Do not explain a joke after making it') || sp.includes('do not explain it'));
    ck('要求别换词重复同一想法',
        sp.includes('Do not repeat the same idea') || sp.includes('never reuse the same joke twice'));
    ck('要求笑点落地就留白', sp.includes('let it breathe'));
    ck('要求留接话空间', sp.includes('Leave natural openings'));
    ck('要求别每次都变成问题', sp.includes('every observation into a question'));
    ck('要求一拳就够',
        sp.includes('One good punchline is often enough') || sp.includes('Not every message needs a full reply'));
    ck('要求变化反应方式',
        sp.includes('Vary your reactions naturally') || sp.includes('reuse the same joke twice'));
    }
}

console.log('\n[2] 示例：数量够 + 是【完整对话】而不是光秃秃一行');
{
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    // 示例对话的正式位置是 llm.persona_examples —— 前端把它单独作为一段 system
    // 注入在"最近历史之后、当前 user 消息之前"，刻意不塞进 system_prompt，
    // 免得 7.5K 示例稀释掉人格主体。旧配置可能仍写在 system_prompt 里，所以两个位置都认。
    const _pe = cfg.llm.persona_examples;
    const src = (typeof _pe === 'string' && _pe.includes('EXAMPLE DIALOGUES'))
        ? _pe : (cfg.llm.system_prompt || '');
    const start = src.indexOf('【EXAMPLE DIALOGUES');
    const end = src.indexOf('【HOW TO LEARN FROM EXAMPLES');
    const block = start >= 0 ? src.slice(start, end > 0 ? end : src.length) : src;
    const ex = [];
    {
        const bl = block.split('\n');
        let cmdText = '', replyText = '', inReply = false;
        const isHeading = (st) => /^###\s+\d+\./.test(st);
        // 用户那一行的前缀是可配置的：{user_name} / user / cmd，或用户设的具体名字（Mika:）
        const isSpeaker = (st) => !st.startsWith('Neuro:')
            && /^(?:\{user_name\}|user|cmd|[A-Za-z][\w-]{0,20})\s*:/.test(st);
        for (const ln of bl) {
            const st = ln.trim();
            if (isHeading(st)) { inReply = false; continue; }
            if (isSpeaker(st)) {
                if (cmdText && replyText) ex.push([cmdText, replyText]);
                cmdText = st.slice(st.indexOf(':') + 1).trim(); replyText = ''; inReply = false;
                continue;
            }
            if (st.startsWith('Neuro:')) {
                const part = st.slice(6).trim();
                replyText = replyText ? (replyText + ' ' + part) : part;
                inReply = true; continue;
            }
            if (inReply && st && !st.startsWith('---') && !st.startsWith('SCENARIO')
                && st.charAt(0) !== '\u3010' && !st.startsWith('- ')) { replyText += ' ' + st; }
        }
        if (cmdText && replyText) ex.push([cmdText, replyText]);
    }
    if (ex.length === 0) {
        console.log('  SKIP  开源版未填写示例对话，跳过示例数量/长度断言');
    } else {
    // 开源版示例集是精简过的（5 条左右），阈值按"够用且有长短对比"来定。
    ck('示例数量 >= 4', ex.length >= 4, `实际 ${ex.length}`);
    ck('每个示例都有 Neuro 的回复', ex.every(m => m[1] && m[1].length > 0),
        `空回复 ${ex.filter(m => !m[1]).length} 个`);

    const norm = (t) => t.split(String.fromCharCode(92) + 'n').join(' ')
        .replace(/[\[\u3010]\s*[A-Za-z0-9_\u4e00-\u9fff \-]{1,40}?\s*[\]\u3011]/g, '')
        .replace(/\s+/g, ' ').trim();
    const lens = ex.map(m => norm(m[1]).length);
    const full = lens.filter(l => l >= 30).length;
    ck('至少有【完整对话】示范（回复 >= 30 字符）', full >= 1, `实际 ${full}/${ex.length}`);
    const shortOnes = lens.filter(l => l <= 30).length;
    ck('仍保留"少即是多"的短回复示范（<= 30 字符）', shortOnes >= 1, `实际 ${shortOnes}`);
    const avg = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
    ck('示例平均长度 <= 280（防止又写成长篇）', avg <= 280, `实际 ${avg.toFixed(1)}`);
    ck('没有失控的超长示例（最长 <= 900）',
        Math.max(...lens) <= 900, `最长 ${Math.max(...lens)}`);
    const withQ = ex.filter(m => norm(m[1]).endsWith('?')).length;
    ck('不是每条都以问号结尾（留白）', withQ < ex.length * 0.5,
        `${withQ}/${ex.length} 条以问号结尾`);
    }
}

console.log('\n[3] 前端场景判据：闲聊 vs 需要深度');
{
    const src = fs.readFileSync(path.join(ROOT, 'js', 'voice-chat.js'), 'utf8');
    ck('有 _needsDepth 判据', src.includes('_needsDepth(text)'));
    ck('有 _pickTokenBudget', src.includes('_pickTokenBudget(prompt)'));
    ck('有 _pickModel', src.includes('_pickModel(prompt)'));
    ck('请求体带 max_tokens', src.includes('max_tokens: this._pickTokenBudget'));
    ck('请求体带动态 model', src.includes('model: this._pickModel'));
}

console.log('\n[4] 后端：预算 override 真正生效');
{
    const src = fs.readFileSync(path.join(ROOT, 'backend', 'agent_bridge.py'), 'utf8');
    ck('llm_stream 接受 max_tokens_override',
        /def llm_stream\(cfg, messages, retries=4, max_tokens_override=None\)/.test(src));
    ck('预算循环使用 override',
        src.includes('budgets = (_ov, max(_ov * _THINK_BUDGET_RETRY, base))'));
    ck('override 模式保留"思考烧光就放大重试"兜底（防失语）',
        src.includes('_ov * _THINK_BUDGET_RETRY'));
    ck('chat_stream 读取 body 的 max_tokens',
        src.includes('(body or {}).get("max_tokens")'));
    ck('chat_stream 读取 body 的 model',
        src.includes('(body or {}).get("model")'));
    ck('模型切换做了白名单校验（防注入）',
        src.includes('_allowed = {cfg.get("llm", {}).get("model")'));
}

console.log('\n[5] 配置：预算已设');
{
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const casual = cfg.llm.chat_budget_casual;
    const deep = cfg.llm.chat_budget_deep;
    ck('有 chat_budget_casual', typeof casual === 'number', String(casual));
    ck('有 chat_budget_deep', typeof deep === 'number', String(deep));
    ck('闲聊预算 < 深度预算', casual < deep, `${casual} vs ${deep}`);
    ck('闲聊预算够写一句但不够写段落（<=900）', casual <= 900, String(casual));
}

console.log(`\n结果：${PASS} PASS / ${FAIL} FAIL`);
process.exit(FAIL === 0 ? 0 : 1);
