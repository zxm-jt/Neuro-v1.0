const { app, BrowserWindow } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 500, height: 500, show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false,
        },
    });

    win.webContents.on('console-message', (_e, level, message) => {
        if (/tts|TTS|播放|play|audio|MediaSource|voice/i.test(message)) {
            console.log('[renderer]', message.slice(0, 300));
        }
    });

    win.webContents.on('render-process-gone', (_e, d) => {
        console.log('[gone]', JSON.stringify(d));
    });

    await win.loadFile(path.join(__dirname, '..', 'index.html'));
    console.log('[probe] page loaded');

    await new Promise(r => setTimeout(r, 4000));

    const result = await win.webContents.executeJavaScript(`(async () => {
        const out = {};
        try {
            out.hasTts = !!window.ttsProcessor;
            out.mseMpeg = (typeof MediaSource !== 'undefined') && MediaSource.isTypeSupported('audio/mpeg');
            out.ttsUrl = window.ttsProcessor && window.ttsProcessor.ttsUrl;

            const t = window.ttsProcessor;
            if (!t) return out;

            const t0 = Date.now();
            const blob = await t.convertTextToSpeech('Hello, this is a voice check.', 'neutral');
            out.synthMs = Date.now() - t0;
            out.blobKind = !blob ? 'null' : (blob.__stream ? 'stream' : (blob.size !== undefined ? 'blob:' + blob.size : typeof blob));

            if (blob && !blob.__stream) {
                const url = URL.createObjectURL(blob);
                const a = new Audio(url);
                const meta = await new Promise((res) => {
                    const done = (v) => res(v);
                    a.onloadedmetadata = () => done({ dur: a.duration });
                    a.onerror = () => done({ err: a.error && a.error.code });
                    setTimeout(() => done({ err: 'meta-timeout' }), 8000);
                });
                out.meta = meta;
                a.volume = 1;
                const tp = Date.now();
                try {
                    await a.play();
                    out.playOk = true;
                    out.playLatencyMs = Date.now() - tp;
                    out.playing = !a.paused;
                    out.duration = a.duration;
                    await new Promise(r => setTimeout(r, 1500));
                    out.currentTimeAfter1_5s = a.currentTime;
                    a.pause();
                } catch (e) {
                    out.playOk = false;
                    out.playErr = (e && e.name) + ': ' + (e && e.message);
                }
            }

            if (blob && blob.__stream) {
                try {
                    await blob.audio.play();
                    out.streamPlayOk = true;
                    await new Promise(r => setTimeout(r, 1500));
                    out.streamCurrentTime = blob.audio.currentTime;
                    out.streamDuration = blob.audio.duration;
                } catch (e) {
                    out.streamPlayOk = false;
                    out.streamErr = (e && e.name) + ': ' + (e && e.message);
                }
            }
        } catch (e) {
            out.fatal = (e && e.name) + ': ' + (e && e.message);
        }
        return out;
    })()`);

    console.log('[RESULT]', JSON.stringify(result, null, 1));
    setTimeout(() => { app.quit(); }, 1500);
});
