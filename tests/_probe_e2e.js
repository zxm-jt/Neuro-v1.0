// 临时探针：名字注入 → 称呼生效 → 英文回复 → 出声（用完即删）
const http = require('http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(p) {
    return new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port: 9222, path: p, timeout: 2000 }, (res) => {
            let s = '';
            res.on('data', (c) => { s += c; });
            res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve(null); } });
        }).on('error', () => resolve(null));
    });
}

function evaluate(target, expression, awaitPromise) {
    return new Promise((resolve) => {
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        ws.addEventListener('open', () => {
            ws.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: { expression, returnByValue: true, awaitPromise: !!awaitPromise },
            }));
        });
        ws.addEventListener('message', (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id === 1) {
                try { ws.close(); } catch (e) {   }
                resolve(m.result && m.result.result ? m.result.result.value : m.result);
            }
        });
        setTimeout(() => resolve({ error: 'ws timeout' }), 60000);
    });
}

async function targets() { return (await get('/json/list')) || []; }

(async () => {
    // 1) 等名字窗口
    let list = [];
    for (let i = 0; i < 70; i++) {
        list = await targets();
        if (list.some((t) => /settings\.html/.test(t.url))) break;
        await sleep(1000);
    }
    const nameWin = list.find((t) => /settings\.html/.test(t.url));
    if (!nameWin) { console.log('STEP1: name window NOT opened'); process.exit(2); }
    console.log('STEP1 name window: opened');

    const r1 = await evaluate(nameWin, `(function(){
        var i = document.getElementById('name');
        i.value = 'Mika';
        document.getElementById('save').click();
        return 'saved';
    })()`);
    console.log('STEP2 save clicked:', JSON.stringify(r1));
    await sleep(2500);

    // 2) 等 voiceChat 就绪并确认称呼已更新
    let live = null;
    for (let i = 0; i < 20; i++) {
        const main = (await targets()).find((t) => /index\.html/.test(t.url));
        if (!main) { await sleep(2000); continue; }
        live = await evaluate(main, `(function(){
            var v = window.voiceChat;
            if (!v) return { ready: false };
            var s = String(((v.messages || []).filter(function(m){return m.role==='system';})[0]||{}).content || '');
            return {
                ready: true,
                label: v._userLabel,
                sysHasName: s.indexOf('Mika') >= 0,
                langRule: s.indexOf('LANGUAGE - HIGHEST PRIORITY') >= 0,
                awaiting: v._awaitingName,
                hasAskFn: typeof v.askUserName === 'function',
                ttsLang: v.ttsProcessor ? v.ttsProcessor.language : null
            };
        })()`);
        if (live && live.ready && live.label === 'Mika') break;
        await sleep(2500);
    }
    console.log('STEP3 live:', JSON.stringify(live));

    // 3) 真的说一句话：走完整 LLM + TTS，看是否英文、是否出声
    const main = (await targets()).find((t) => /index\.html/.test(t.url));
    const convo = await evaluate(main, `(async function(){
        try {
            window.__probeReply = '';
            var v = window.voiceChat;
            var t = window.ttsProcessor;
            var t0 = Date.now();
            await v.sendToLLM('Hi, can you hear me?');
            var deadline = Date.now() + 25000;
            while (Date.now() < deadline) {
                if (t && t.isPlaying && t.isPlaying()) break;
                await new Promise(r => setTimeout(r, 300));
            }
            var a = t && t.currentAudio;
            var ct1 = a ? a.currentTime : -1;
            await new Promise(r => setTimeout(r, 1800));
            var ct2 = a ? a.currentTime : -1;
            var last = (v.messages || []).filter(function(m){ return m.role === 'assistant'; }).slice(-1)[0] || {};
            var text = String(last.content || '');
            return {
                ms: Date.now() - t0,
                reply: text.slice(0, 180),
                hasChinese: /[\\u4e00-\\u9fff]/.test(text),
                audioAdvanced: ct2 > ct1 && ct2 > 0,
                ct1: ct1, ct2: ct2,
                playing: !!(t && t.isPlaying && t.isPlaying())
            };
        } catch (e) {
            return { err: (e && e.name) + ': ' + (e && e.message) };
        }
    })()`, true);
    console.log('STEP4 convo:', JSON.stringify(convo));

    process.exit(0);
})();
