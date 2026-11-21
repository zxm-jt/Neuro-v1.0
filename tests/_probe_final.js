// 临时探针：名字 / 记忆注入 / 英文出声 三项联验（用完即删）
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
                id: 1, method: 'Runtime.evaluate',
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
        setTimeout(() => resolve({ error: 'ws timeout' }), 90000);
    });
}

(async () => {
    let list = [];
    let main = null;
    for (let i = 0; i < 60; i++) {
        list = await get('/json/list') || [];
        main = list.find((t) => /index\.html/.test(t.url));
        if (main) {
            const ok = await evaluate(main, '!!(window.voiceChat)');
            if (ok === true) break;
        }
        await sleep(1500);
    }
    if (!main) { console.log('FAIL: no index.html'); process.exit(2); }

    const st = await evaluate(main, `(function(){
        var v = window.voiceChat;
        if (!v) return { ready: false };
        var sys = String(((v.messages||[]).filter(function(m){return m.role==='system';})[0]||{}).content||'');
        return {
            ready: true,
            label: v._userLabel,
            sysHasName: sys.indexOf('Mika') >= 0,
            langRule: sys.indexOf('LANGUAGE - HIGHEST PRIORITY') >= 0,
            ttsLang: v.ttsProcessor ? v.ttsProcessor.language : null,
            awaiting: v._awaitingName,
            hasAskFn: typeof v.askUserName === 'function',
            nameFile: (function(){ try { return require('fs').readFileSync(require('path').join(__dirname,'memory','user_name.txt'),'utf8').trim(); } catch(e){ return 'ERR'; } })(),
            vocalGone: typeof window.__vocalProbe === 'undefined'
        };
    })()`);
    console.log('STATE:', JSON.stringify(st));

    const mem = await evaluate(main, `(async function(){
        async function q(t){
            try {
                var r = await fetch('http://127.0.0.1:6006/v1/memory/recall', {
                    method:'POST', headers:{'Content-Type':'application/json'},
                    body: JSON.stringify({text:t})
                });
                var j = await r.json();
                return { q:t, hits:j.hits, ctx:(j.context||'').slice(0,120) };
            } catch(e){ return { q:t, err:String(e&&e.message) }; }
        }
        return {
            resident: await (async function(){ try {
                var r = await fetch('http://127.0.0.1:6006/v1/memory/context');
                var j = await r.json();
                return (j.context||'').length;
            } catch(e){ return 'ERR'; } })(),
            relevant: await q('TTS port conflict'),
            unrelated: await q('what did you eat today'),
            forced: await q('do you remember what we did last time')
        };
    })()`, true);
    console.log('MEMORY:', JSON.stringify(mem));

    const convo = await evaluate(main, `(async function(){
        try {
            var v = window.voiceChat, t = window.ttsProcessor;
            var t0 = Date.now();
            await v.sendToLLM('Hi, can you hear me?');
            var dl = Date.now() + 25000;
            while (Date.now() < dl) {
                if (t && t.isPlaying && t.isPlaying()) break;
                await new Promise(function(r){ setTimeout(r, 300); });
            }
            var a = t && t.currentAudio;
            var c1 = a ? a.currentTime : -1;
            await new Promise(function(r){ setTimeout(r, 1800); });
            var c2 = a ? a.currentTime : -1;
            var last = (v.messages||[]).filter(function(m){return m.role==='assistant';}).slice(-1)[0]||{};
            var txt = String(last.content||'');
            return {
                ms: Date.now()-t0,
                reply: txt.slice(0,160),
                hasChinese: /[\\u4e00-\\u9fff]/.test(txt),
                audioAdvanced: c2 > c1 && c2 > 0,
                c1: c1, c2: c2
            };
        } catch(e){ return { err: String(e&&e.message) }; }
    })()`, true);
    console.log('CONVO:', JSON.stringify(convo));

    const brain = await evaluate(main, `(async function(){
        try {
            var r = await fetch('http://127.0.0.1:6006/v1/brain/viz?since=0');
            var j = await r.json();
            return { frame: j.frame, n: j.n, frames: (j.frames||[]).length, kc: j.kc, mbon: j.mbon };
        } catch(e){ return { err: String(e&&e.message) }; }
    })()`, true);
    console.log('BRAIN:', JSON.stringify(brain));

    process.exit(0);
})();
