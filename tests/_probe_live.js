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

function evaluate(target, expression) {
    return new Promise((resolve) => {
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        ws.addEventListener('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
        });
        ws.addEventListener('message', (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id === 1) { try { ws.close(); } catch (e) {   } resolve(m.result && m.result.result && m.result.result.value); }
        });
        setTimeout(() => resolve({ error: 'timeout' }), 8000);
    });
}

(async () => {
    const list = await get('/json/list') || [];
    const main = list.find((t) => /index\.html/.test(t.url));
    if (!main) { console.log('no index.html target'); process.exit(1); }

    const expr = [
        '(function(){',
        '  var v = window.voiceChat;',
        '  if (!v) return { voiceChat: false };',
        '  var sys = (v.messages || []).filter(function(m){return m.role === "system";})[0] || {};',
        '  var s = String(sys.content || "");',
        '  return {',
        '    voiceChat: true,',
        '    label: v._userLabel,',
        '    awaitingName: v._awaitingName,',
        '    hasAskFn: typeof v.askUserName === "function",',
        '    sysHasName: s.indexOf("Alex") >= 0,',
        '    sysHasLangRule: s.indexOf("LANGUAGE - HIGHEST PRIORITY") >= 0,',
        '    ttsLang: v.ttsProcessor ? v.ttsProcessor.language : null,',
        '    msgCount: (v.messages || []).length',
        '  };',
        '})()',
    ].join('\n');

    for (let i = 0; i < 6; i++) {
        const r = await evaluate(main, expr);
        console.log('LIVE[' + i + ']:', JSON.stringify(r));
        if (r && r.voiceChat) break;
        await sleep(4000);
    }
    process.exit(0);
})();
