#!/usr/bin/env node
// tests/check_brevity.js —— 短句化：提示词规则 + 场景判据 + 示例长度
//
// 用户的要求："她不应该把每一次交流都当成一次需要完整回答的考试。"
// 三层保障：
//   ① 提示词三段（BREVITY / RHYTHM / NATURAL HUMOUR）
//   ② 20 组示例【全部短句示范】（示范克制，比规则更有效）
//   ③ 请求层：闲聊小 token 预算 / 深度问题大预算
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
    // 【2026-11-22 修 · 测试过期】原版与开源版的提示词分段/措辞不同，
    // 但【规则本身等价】。断言按"语义等价变体任一命中"来判，
    // 而不是死抠某一句英文 —— 否则开源版那边会全线误报。
    //   原版：CONVERSATIONAL BREVITY / LIVE CONVERSATION RHYTHM 两段
    //   开源版：合并成 BREVITY & RHYTHM 一段
    const any = (...frags) => frags.some(f => sp.includes(f));
    ck('有 CONVERSATIONAL BREVITY 段',
        any('CONVERSATIONAL BREVITY', 'BREVITY & RHYTHM', 'REPLY LENGTH'));
    ck('有 LIVE CONVERSATION RHYTHM 段',
        any('LIVE CONVERSATION RHYTHM', 'BREVITY & RHYTHM'));
    ck('有 NATURAL HUMOUR 段', sp.includes('NATURAL HUMOUR'));
    ck('要求简单反应通常一句',
        any('should usually be one sentence', 'a simple reaction is one sentence'));
    ck('要求闲聊 1~3 句', sp.includes('one to three short sentences'));
    ck('要求别解释笑话', sp.includes('Do not explain a joke after making it'));
    ck('要求别换词重复同一想法', sp.includes('Do not repeat the same idea'));
    ck('要求笑点落地就留白', sp.includes('let it breathe'));
    ck('要求留接话空间',
        any('Leave natural openings', 'One main thought per reply, then stop'));
    ck('要求别每次都变成问题', sp.includes('every observation into a question'));
    ck('要求一拳就够',
        any('One good punchline is often enough',
            'Do not reach for a punchline every turn'));
    ck('要求变化反应方式',
        any('Vary your reactions naturally', 'vary your reactions naturally'));
}

console.log('\n[2] 示例：数量够 + 是【完整对话】而不是光秃秃一行');
{
    // 【2026-11-05 换标准】用户要求："对话示例必须写上"。
    //   旧标准（一律 <= 90 字符）来自"刻意短"那一版，把示例压成了
    //   「标签 + 半句话」，等于没给模型看【她到底怎么说话】的样本。
    //   现在：示例必须是完整对话（有真实台词、能体现语气和结构），
    //   同时保留几条"短回复/纯表情"的示范（有时少即是多），
    //   并设上限防止又写成长篇。
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    // 【2026-11-22 修 · 测试过期】示例块上一轮已从 llm.system_prompt 拆出，
    // 搬到了 llm.persona_examples（由前端作为独立 system 段注入）。
    // 这个测试还在读旧位置 → 解析到 0 条示例 → 全线误报。
    // 现在：优先读 persona_examples，找不到再回落旧的 system_prompt 内嵌写法。
    let block = '';
    const pe = (cfg.llm && cfg.llm.persona_examples) || '';
    if (pe.includes('EXAMPLE DIALOGUES') || pe.includes('EXAMPLE CONVERSATIONS')) {
        block = pe;
    } else {
        const sp0 = cfg.llm.system_prompt || '';
        const start = sp0.indexOf('【EXAMPLE DIALOGUES');
        const end = sp0.indexOf('【HOW TO LEARN FROM EXAMPLES');
        block = sp0.slice(start, end > 0 ? end : sp0.length);
    }
    // 逐行解析：遇到用户台词行收集台词，遇到 'Neuro:' 收集回复（可跨行）
    // 【关键】块标题行（"### 3. ..."）与 "--- 说明行" 必须跳过 ——
    //   否则它们会被当成回复正文，把长度算高、把回复内容算脏。
    // 【2026-11-22】用户台词前缀两项目不同：原版是 "cmd:"，
    //   开源版是 "{user_name}:"（模板占位，前端注入时替换成实际名字）。
    //   两种都要认，否则示例一条都解析不出来。
    const USER_RE = /^(?:cmd|user|\{user_name\}):\s*/;
    const ex = [];
    {
        const bl = block.split('\n');
        let cmdText = '', replyText = '', inReply = false;
        const isHeading = (st) => /^###\s+\d+\./.test(st);
        for (const ln of bl) {
            const st = ln.trim();
            if (isHeading(st)) { inReply = false; continue; }
            const um = USER_RE.exec(st);
            if (um) {
                if (cmdText && replyText) ex.push([cmdText, replyText]);
                cmdText = st.slice(um[0].length).trim(); replyText = ''; inReply = false;
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
    // 数量下限按【场景数】算，不按对话条数算 —— 两项目的示例条数不同
    // （原版 17 组场景 / 开源版 9 组场景），但底线要求一样：
    // 至少 9 组场景、至少 12 条对话，而且每组场景都要有真实台词。
    const sceneCount = (block.match(/^###\s+\d+\./gm) || []).length;
    ck('示例场景数 >= 9', sceneCount >= 9, `实际 ${sceneCount}`);
    ck('示例数量 >= 12', ex.length >= 12, `实际 ${ex.length}`);
    ck('每个示例都有 Neuro 的回复', ex.every(m => m[1] && m[1].length > 0),
        `空回复 ${ex.filter(m => !m[1]).length} 个`);

    // 归一化回复文本（剥掉情绪标签 —— 标签不是台词）
    const norm = (t) => t.split(String.fromCharCode(92) + 'n').join(' ')
        .replace(/[\[\u3010]\s*[A-Za-z0-9_\u4e00-\u9fff \-]{1,40}?\s*[\]\u3011]/g, '')
        .replace(/\s+/g, ' ').trim();
    const lens = ex.map(m => norm(m[1]).length);
    const full = lens.filter(l => l >= 30).length;
    ck('多数示例是【完整对话】（回复 >= 30 字符，不是一行标签）',
        full >= Math.ceil(ex.length * 0.6), `实际 ${full}/${ex.length}`);
    const shortOnes = lens.filter(l => l <= 30).length;
    ck('仍保留"少即是多"的短回复示范（>= 2 条 <= 30 字符）',
        shortOnes >= 2, `实际 ${shortOnes}`);
    const avg = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
    ck('示例平均长度 <= 280（防止又写成长篇）', avg <= 280, `实际 ${avg.toFixed(1)}`);
    ck('没有失控的超长示例（最长 <= 900）',
        Math.max(...lens) <= 900, `最长 ${Math.max(...lens)}`);
    // 不该出现的模式：每个回复都带问号
    const withQ = ex.filter(m => norm(m[1]).endsWith('?')).length;
    ck('不是每条都以问号结尾（留白）', withQ < ex.length * 0.5,
        `${withQ}/${ex.length} 条以问号结尾`);
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
