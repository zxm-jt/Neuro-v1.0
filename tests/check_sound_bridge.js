const { SoundBridge, DEFAULT_BASE, DEFAULT_POLL_MS } = require('../js/sound-bridge.js');

let pass = 0, fail = 0;
function ck(name, ok, extra) {
    if (ok) pass++; else fail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n         ' + extra}`);
}

console.log('=== 情绪/意图桥接 ===\n');

const okFetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ ok: true, intent: 'exploratory' }),
});

(async () => {
    ck('默认后端地址正确', DEFAULT_BASE.includes('6006'));
    ck('默认轮询间隔合理', DEFAULT_POLL_MS >= 10000 && DEFAULT_POLL_MS <= 120000);

    let sb = new SoundBridge({ fetch: okFetch });
    sb.setEmotion('Happy');
    ck('情绪规范化为小写', sb.state().emotion === 'happy', JSON.stringify(sb.state()));

    sb = new SoundBridge({ fetch: okFetch });
    const it = await sb.pollIntent();
    ck('意图拉取成功', it === 'exploratory' && sb.state().intent === 'exploratory', JSON.stringify(sb.state()));

    sb.setEmotion('sad');
    ck('情绪+意图同时提供', sb.state().emotion === 'sad' && sb.state().intent === 'exploratory', JSON.stringify(sb.state()));

    // 5) 后端不可达 → 回落，不抛
    const badFetch = () => Promise.reject(new Error('ECONNREFUSED'));
    sb = new SoundBridge({ fetch: badFetch });
    let threw = false;
    try { await sb.pollIntent(); } catch (e) { threw = true; }
    ck('后端不可达不抛异常', !threw && sb.state().intent === null);

    sb = new SoundBridge({ fetch: () => Promise.resolve({ ok: false }) });
    await sb.pollIntent();
    ck('非 200 响应 → 意图为空', sb.state().intent === null);

    sb = new SoundBridge({ fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }) });
    await sb.pollIntent();
    ck('缺 intent 字段 → 空', sb.state().intent === null);

    sb = new SoundBridge({ fetch: okFetch });
    sb.setEmotion('happy');
    sb._emotionAt = Date.now() - 300001;
    ck('情绪 5 分钟过期 → null', sb.state().emotion === null, JSON.stringify(sb.state()));

    await sb.pollIntent();
    sb._intentAt = Date.now() - 120001;
    ck('意图 2 分钟过期 → null', sb.state().intent === null, JSON.stringify(sb.state()));

    sb.setEmotion('');
    ck('空情绪 → null', sb.state().emotion === null);

    console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
    process.exit(fail > 0 ? 1 : 0);
})();
