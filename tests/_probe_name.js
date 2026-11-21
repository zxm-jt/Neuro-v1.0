// 临时探针：通过 CDP 验证名字注入窗口是完整可用的（用完即删）
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(p) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: 9222, path: p, timeout: 2500 }, (res) => {
            let s = '';
            res.on('data', (c) => { s += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(s)); } catch (e) { resolve(null); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function evalIn(target, expression) {
    return new Promise((resolve) => {
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        const done = (v) => { try { ws.close(); } catch (e) {   } resolve(v); };
        ws.addEventListener('open', () => {
            ws.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: { expression, awaitPromise: true, returnByValue: true },
            }));
        });
        ws.addEventListener('message', (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id === 1) done(m.result);
        });
        ws.addEventListener('error', () => done({ error: 'ws error' }));
        setTimeout(() => done({ error: 'ws timeout' }), 8000);
    });
}

(async () => {
    let list = [];
    for (let i = 0; i < 70; i++) {
        try { list = await httpGet('/json/list') || []; } catch (e) { list = []; }
        if (list.some((t) => /settings\.html/.test(t.url))) break;
        await sleep(1000);
    }
    console.log('TARGETS:', list.map((t) => t.url).join(' | ') || '(none)');

    const nameWin = list.find((t) => /settings\.html/.test(t.url));
    if (!nameWin) { console.log('RESULT: name window NOT opened'); process.exit(2); }

    const pre = await evalIn(nameWin, `(function(){
        var i = document.getElementById('name');
        return { hasInput: !!i, prefill: i ? i.value : null,
                 title: document.querySelector('h1').textContent,
                 focused: document.activeElement === i };
    })()`);
    console.log('PRE:', JSON.stringify(pre.result && pre.result.value));

    const typed = await evalIn(nameWin, `(function(){
        var i = document.getElementById('name');
        i.value = 'Alex';
        document.getElementById('save').click();
        return 'clicked';
    })()`);
    console.log('TYPE:', JSON.stringify(typed.result && typed.result.value));

    await sleep(2000);

    const main = (await httpGet('/json/list') || []).find((t) => /index\.html/.test(t.url));
    if (main) {
        const live = await evalIn(main, `(function(){
            var vc = window.voiceChat;
            if (!vc) return { voiceChat: false };
            var sys = (vc.messages || []).find(function(m){ return m.role === 'system'; }) || {};
            var s = String(sys.content || '');
            return {
                voiceChat: true,
                label: vc._userLabel,
                systemHasName: s.indexOf('Alex') >= 0,
                systemHasLangRule: s.indexOf('LANGUAGE - HIGHEST PRIORITY') >= 0,
                awaitingName: vc._awaitingName,
                hasAskFn: typeof vc.askUserName === 'function'
            };
        })()`);
        console.log('LIVE:', JSON.stringify(live.result && live.result.value));
    } else {
        console.log('LIVE: index.html target not found');
    }

    const stillOpen = (await httpGet('/json/list') || []).some((t) => /settings\.html/.test(t.url));
    console.log('NAME WINDOW CLOSED AFTER SAVE:', !stillOpen);
    process.exit(0);
})();
