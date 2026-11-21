// 临时探针：只等 voiceChat 构建完成，核对名字与记忆注入（不发声）
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
            if (m.id === 1) {
                try { ws.close(); } catch (e) {   }
                resolve(m.result && m.result.result ? m.result.result.value : null);
            }
        });
        setTimeout(() => resolve(null), 8000);
    });
}

(async () => {
    let main = null;
    let st = null;
    for (let i = 0; i < 100; i++) {
        const list = await get('/json/list') || [];
        main = list.find((t) => /index\.html/.test(t.url));
        if (main) {
            st = await evaluate(main, `(function(){
                var v = window.voiceChat;
                if (!v) return { ready:false, model: typeof window.modelController, tts: typeof window.ttsProcessor,
                                 pixi: typeof PIXI !== 'undefined',
                                 live2d: !!(window.PIXI && PIXI.live2d && PIXI.live2d.Live2DModel) };
                var sys = String(((v.messages||[]).filter(function(m){return m.role==='system';})[0]||{}).content||'');
                return { ready:true, label:v._userLabel, awaiting:v._awaitingName,
                         hasAsk: typeof v.askUserName === 'function',
                         sysHasName: sys.indexOf('Mika') >= 0,
                         langRule: sys.indexOf('LANGUAGE - HIGHEST PRIORITY') >= 0,
                         ttsLang: v.ttsProcessor ? v.ttsProcessor.language : null,
                         sysLen: sys.length,
                         vocalGone: typeof require('fs').existsSync === 'function' &&
                                    !require('fs').existsSync(require('path').join(__dirname,'js','vocal-sounds.js')) };
            })()`);
            if (st && st.ready) break;
        }
        await sleep(3000);
    }
    console.log('FINAL:', JSON.stringify(st));
    process.exit(0);
})();
