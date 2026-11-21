const path = require('path');
const { ASRProcessor } = require(path.join(__dirname, '..', 'js', 'asr-processor.js'));

const HOLD = 60;   // 测试里缩短窗口，避免等真实 1200ms
let pass = 0, fail = 0;
function ck(name, ok, extra = '') {
    if (ok) { pass++; console.log('  PASS ', name, extra); }
    else { fail++; console.log('  FAIL ', name, extra); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function make(cfg = {}) {
    const p = new ASRProcessor(null, null, {
        asr: {
            stream_url: 'ws://127.0.0.1:6006/v1/asr_stream',
            utterance_hold_ms: HOLD,
            utterance_max_wait_ms: HOLD * 4,
            ...cfg,
        },
    });
    p.isProcessingAudio = false;
    p._streamSend = () => {};
    p.submitted = [];
    p.onSpeechRecognized = (text, raw, opts) => {
        p.submitted.push({ text, raw, duringTts: !!(opts && opts.duringTts) });
    };
    return p;
}

(async () => {
    console.log('[1] 【首段疑似半句】被切成两段 → 仍合并成一次提交');
    {
        const p = make();
        p._queueStreamUtterance('说的话识别正确呢', '说的话识别正确呢', {});
        await sleep(HOLD / 2);
        p._queueStreamUtterance('而且他说话说得太急了。', '而且他说话说得太急了。', {});
        ck('窗口内不提前抢答', p.submitted.length === 0, `实际 ${p.submitted.length} 次`);
        await sleep(HOLD + 40);
        ck('整句只提交一次', p.submitted.length === 1, `实际 ${p.submitted.length} 次`);
        ck('两段都进了同一句',
            p.submitted[0] && p.submitted[0].text.includes('说的话识别正确')
            && p.submitted[0].text.includes('而且他说话'),
            p.submitted[0] ? `"${p.submitted[0].text}"` : '无提交');
        p.closeStream();
    }

    console.log('[2] 【2026-11-08 降延迟】单段完整句 → 立即提交，不等窗口');
    {
        const p = make();
        p._queueStreamUtterance('今天天气不错。', '今天天气不错。', {});
        // 有句末标点 = 明显说完 → 立即提交（这正是省掉 1800ms 空等的关键路径）
        ck('完整句立即提交（0 等待）', p.submitted.length === 1, `实际 ${p.submitted.length} 次`);
        ck('内容正确', p.submitted[0] && p.submitted[0].text === '今天天气不错。',
            p.submitted[0] ? `"${p.submitted[0].text}"` : '无提交');
        p.closeStream();
    }

    console.log('[2b] 【2026-11-08 降延迟】疑似半句 → 才保留等待窗口');
    {
        const p = make();
        p._queueStreamUtterance('我想说的是', '我想说的是', {});
        ck('半句不立即提交', p.submitted.length === 0, `实际 ${p.submitted.length} 次`);
        await sleep(HOLD + 40);
        ck('窗口到点提交', p.submitted.length === 1, `实际 ${p.submitted.length} 次`);
        p.closeStream();
    }

    console.log('[3] 她说话期间的插话 → 立即提交，打断不能等');
    {
        const p = make();
        p._queueStreamUtterance('先说一半', '先说一半', {});
        p.isProcessingAudio = true;
        p._queueStreamUtterance('等一下', '等一下', { duringTts: true });
        ck('立即提交（不等窗口）', p.submitted.length === 1, `实际 ${p.submitted.length} 次`);
        ck('整句带上前半段 + 标记插话',
            p.submitted[0] && p.submitted[0].text.includes('先说一半')
            && p.submitted[0].duringTts === true,
            p.submitted[0] ? JSON.stringify(p.submitted[0]) : '无提交');
        p.closeStream();
    }

    console.log('[4] 连续碎段不会无限挂着（max_wait 封顶）');
    {
        const p = make({ utterance_max_wait_ms: HOLD * 2 });
        for (let i = 0; i < 6; i++) {
            p._queueStreamUtterance('第' + i + '段', '第' + i + '段', {});
            await sleep(HOLD / 2);
        }
        await sleep(HOLD * 2 + 60);
        ck('最终一定提交', p.submitted.length >= 1, `实际 ${p.submitted.length} 次`);
        ck('没有残留待提交缓冲', p._uttPending === null && p._uttTimer === null);
        p.closeStream();
    }

    console.log('[5] 挂起麦克风 → 待提交的半句作废');
    {
        const p = make();
        p._queueStreamUtterance('半句还没说完', '半句还没说完', {});
        p.suspendMic(true);
        await sleep(HOLD + 60);
        ck('挂起后不回话', p.submitted.length === 0, `实际 ${p.submitted.length} 次`);
        p.closeStream();
    }

    console.log('[6] 关掉等待（hold=0）→ 保持旧行为，逐段立即提交');
    {
        const p = make({ utterance_hold_ms: 0, utterance_max_wait_ms: 0 });
        p._queueStreamUtterance('第一段。', '第一段。', {});
        p._queueStreamUtterance('第二段。', '第二段。', {});
        ck('两段立刻各提交一次', p.submitted.length === 2, `实际 ${p.submitted.length} 次`);
        p.closeStream();
    }

    console.log('[7] 后端漏标 during_tts，但本地知道她正在播 TTS → 仍立即提交');
    {
        const p = make();
        p.isProcessingAudio = true;
        p._queueStreamUtterance('等一下', '等一下', {});
        ck('不等窗口就打断', p.submitted.length === 1, `实际 ${p.submitted.length} 次`);
        p.closeStream();
    }

    console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
})();
