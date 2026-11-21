const { app, BrowserWindow, ipcMain, screen, globalShortcut, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const net = require('net')
const { spawn } = require('child_process')
const CommandRouter = require('./command-router.js')
const { VisionFramePump } = require('./vision-pump.js')

const { ChatMonitor } = require('./chat-monitor.js')
let chatMonitor = null
const { ChatRoom } = require('./chatroom.js')
let chatRoom = null

const BACKEND_PORT = 6006
const BACKEND_HOST = '127.0.0.1'

let _appPathCache = null;
function appPath() {
    if (_appPathCache === null) {
        try { _appPathCache = app.getAppPath(); } catch (e) { _appPathCache = process.cwd(); }
    }
    return _appPathCache;
}
const CONFIG_PATH = () => path.join(appPath(), 'config.json');
const DEFAULT_CONFIG_PATH = () => path.join(appPath(), 'default_config.json');
const QUIT_FLAG_FILE = () => path.join(appPath(), '.quit_request');

let backendProcess = null

let _lastBackendSpawnAt = 0


let _quitting = false
let _quitTimer = null        
let _allowQuit = false

let mainWindowRef = null

function hardExit(code) {
    
    
    try { killBackendIfOwned() } catch (e) {  }
    try { app.exit(code) } catch (e) {   }
}

const _diagLog = (...args) => {
    try {
        const f = path.join(__dirname, '..', 'logs', 'backend_diag.log');
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.appendFileSync(f, '[' + new Date().toTimeString().slice(0, 8) + '] [main] ' + args.join(' ') + '\n');
    } catch (e) {   }
};

const EXIT_SUMMARY_FILE = () => path.join(__dirname, '..', 'logs', 'exit_summary.txt');
const _exitLines = [];               
let _exitReportStarted = false;
let _exitReportFrom = 0;

function _exitSay(line) {
    const text = '[' + new Date().toTimeString().slice(0, 8) + '] [EXIT] ' + String(line);
    _exitLines.push(text);
    if (_exitLines.length > 120) _exitLines.shift();
    console.log(text);
    try {
        const f = EXIT_SUMMARY_FILE();
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.appendFileSync(f, text + '\n', 'utf8');
    } catch (e) {   }
}

function _exitBegin() {
    if (_exitReportStarted) return;
    _exitReportStarted = true;
    _exitReportFrom = _exitLines.length;
    _exitSay('========== 桌宠退出 · 记忆总结并关闭 ==========');
}

function _loadLastExitReport() {
    try {
        const f = EXIT_SUMMARY_FILE();
        if (!fs.existsSync(f)) return;
        const all = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean);
        let start = 0;
        for (let i = all.length - 1; i >= 0; i--) {
            if (all[i].indexOf('桌宠退出') >= 0) { start = i; break; }
        }
        _exitLines.push('---------- 上次退出时的记录 ----------');
        for (const l of all.slice(start)) {
            if (_exitLines.length < 120) _exitLines.push(l);
        }
    } catch (e) {   }
}
_loadLastExitReport();

function setupPortableMode() {
    try {
        const portableDir = process.env.PORTABLE_EXECUTABLE_DIR || null;
        const marker = path.join(app.getAppPath(), 'portable');
        const isPortable = !!portableDir || fs.existsSync(marker);
        if (!isPortable) return null;
        const root = portableDir || app.getAppPath();
        const ud = path.join(root, 'userData');
        app.setPath('userData', ud);
        _diagLog('[portable] 便携模式生效，userData →', ud);
        return ud;
    } catch (e) {
        _diagLog('[portable] 便携模式设置失败（不影响启动）:', e && e.message);
        return null;
    }
}
const _portableUserData = setupPortableMode();

function resolvePython() {
    const env = process.env.NEURO_VENV;
    const candidates = [];
    if (env) candidates.push({ path: env, why: 'NEURO_VENV 环境变量' });
    candidates.push(
        { path: path.join(app.getAppPath(), 'python', 'python.exe'), why: '盘内自带 Python' },
        { path: path.join(app.getAppPath(), 'python', 'Scripts', 'python.exe'), why: '盘内自带 Python(Scripts)' },
        { path: path.join(app.getAppPath(), 'py', 'python.exe'), why: '盘内 py 目录' },
    );
    candidates.push({
        path: 'C:\\Users\\<YOUR_USER>\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe',
        why: '本机 venv',
    });
    for (const name of ['python', 'python3']) {
        try {
            const r = require('child_process').spawnSync('where', [name], { windowsHide: true });
            if (r.status === 0 && r.stdout) {
                const first = r.stdout.toString('utf8').split(/\r?\n/)[0].trim();
                if (first) candidates.push({ path: first, why: `PATH 上的 ${name}` });
            }
        } catch (e) {   }
    }

    const { spawnSync } = require('child_process');
    const tried = [];
    let firstExisting = null;
    for (const c of candidates) {
        if (!c.path || !fs.existsSync(c.path)) { tried.push(`${c.path} (${c.why}) → 不存在`); continue; }
        if (!firstExisting) firstExisting = c;
        let ok = false;
        try {
            const t = spawnSync(c.path, ['-c', 'import fastapi, numpy'], {
                timeout: 20000, windowsHide: true,
            });
            ok = t.status === 0;
            if (!ok) {
                const err = (t.stderr || t.stdout || Buffer.alloc(0)).toString('utf8').split('\n')[0];
                tried.push(`${c.path} (${c.why}) → 缺依赖: ${err.slice(0, 80)}`);
            }
        } catch (e) {
            tried.push(`${c.path} (${c.why}) → 自检异常: ${e.message}`);
        }
        if (ok) {
            _diagLog(`[python] 选中: ${c.path} (${c.why}, 依赖自检通过)`);
            return c.path;
        }
    }
    if (firstExisting) {
        console.warn('[python] 警告：没有候选通过依赖自检，仍尝试:', firstExisting.path);
        for (const t of tried) console.warn('  [python] ' + t);
        return firstExisting.path;
    }
    for (const t of tried) console.warn('  [python] ' + t);
    return null;
}

function spawnBackend() {
    
    const venv = resolvePython();
    if (!venv) {
        const msg = '[main] 找不到 Python 解释器！后端无法启动。\n'
            + '  解决办法（任一即可）：\n'
            + '  1) 设置环境变量 NEURO_VENV 指向一个 Python 3.10+ 的 python.exe\n'
            + '  2) 在程序目录下放 python\\python.exe（便携 Python）\n'
            + '  3) 装一个系统 Python 并确保 PATH 里有它\n'
            + '  依赖需求见 backend\\requirements.txt（fastapi/numpy/faster-whisper）';
        console.error(msg);
        try {
            const logPath = path.join(app.getAppPath(), 'backend', 'backend.log');
            fs.appendFileSync(logPath, msg + '\n');
        } catch (e) {   }
        return null;
    }
    if (backendProcess && !backendProcess.killed) {
        try { backendProcess.kill(); } catch (e) {   }
    }
    backendProcess = null
    _lastBackendSpawnAt = Date.now()
    const script = path.join(__dirname, '..', 'backend', 'neuro_server.py');
    const logPath = path.join(__dirname, '..', 'backend', 'backend.log')
    let stream = null
    try {
        stream = fs.createWriteStream(logPath, { flags: 'a' })
        stream.write(`\n===== 后端启动 ${new Date().toLocaleString()} =====\n`)
    } catch (e) {
        console.error('[main] 无法打开后端日志:', e)
    }
    const p = spawn(venv, [script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
    })
    const decOut = new TextDecoder('utf-8')
    const decErr = new TextDecoder('utf-8')
    const pipeOut = (b) => {
        const s = decOut.decode(b, { stream: true })
        try { process.stdout.write(s) } catch (e) { }
        if (stream) { try { stream.write(s) } catch (e) { } }
    }
    p.stdout.on('data', pipeOut)
    p.stderr.on('data', (b) => {
        const s = decErr.decode(b, { stream: true })
        try { process.stderr.write(s) } catch (e) { }
        if (stream) { try { stream.write(s) } catch (e) { } }
    })
    p.on('exit', (c) => {
        console.log('[main] 后端进程退出 code=' + c)
        if (stream) { try { stream.write(`[main] 后端退出 code=${c}\n`); stream.end() } catch (e) { } }
    })
    p.on('error', (e) => { console.error('[main] 后端启动失败:', e); if (stream) stream.write('[main] spawn error: ' + e + '\n') })
    return p
}

function ensureBackend() {
    return new Promise((resolve) => {
        const tryConnect = () => new Promise((ok) => {
            const s = net.connect(BACKEND_PORT, BACKEND_HOST)
            s.setTimeout(500)
            s.on('connect', () => { s.destroy(); ok(true) })
            s.on('error', () => { s.destroy(); ok(false) })
            s.on('timeout', () => { s.destroy(); ok(false) })
        })
        const waitUp = (tries) => tryConnect().then((up) => {
            if (up) return true
            if (tries <= 0) return false
            return new Promise((r) => setTimeout(r, 700)).then(() => waitUp(tries - 1))
        })
        tryConnect().then((already) => {
            if (already) { console.log('[main] 后端已在 6006 运行，跳过自拉起'); resolve(); return }
            _diagLog('[main] 后端未运行，自拉起')
            backendProcess = spawnBackend()
            waitUp(35).then(() => resolve())
        })
    })
}

function startBackendWatchdog() {
    const logPath = path.join(app.getAppPath(), 'logs', 'backend_watch.log');
    const wlog = (msg) => {
        const line = `[${new Date().toISOString()}] ${msg}\n`;
        console.log('[main] 看门狗: ' + msg);
        try {
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            fs.appendFileSync(logPath, line);
        } catch (e) {   }
    };
    const probe = () => new Promise((ok) => {
        const s = net.connect(BACKEND_PORT, BACKEND_HOST);
        let up = false;
        s.setTimeout(600);
        s.on('connect', () => { up = true; s.destroy(); });
        s.on('error', () => { s.destroy(); });
        s.on('timeout', () => { s.destroy(); });
        setTimeout(() => ok(up), 900);
    });
    let spawning = false;
    let fails = 0;
    let backoff = 0;
    
    
    const BOOT_GRACE_MS = 90000;
    const restart = (why) => {
        if (spawning) return;
        const alive = backendProcess && backendProcess.exitCode === null && !backendProcess.killed;
        if (alive) {
            const age = Date.now() - (_lastBackendSpawnAt || 0);
            if (age < BOOT_GRACE_MS) {
                wlog(`后端进程存活 ${Math.round(age / 1000)}s（启动/预热中），先不重拉`);
                return;
            }
            wlog(`后端进程存活 ${Math.round(age / 1000)}s 但端口始终无响应，结束它再重拉`);
        }
        spawning = true;
        wlog(`后端无响应（${why}），尝试重新拉起`);
        const child = spawnBackend();
        if (!child) {
            spawning = false;
            fails++;
            wlog(`拉起失败：找不到 Python 解释器（累计失败 ${fails} 次）`);
            return;
        }
        child.once('exit', (code, sig) => {
            spawning = false;
            if (code !== 0) {
                backoff = Math.min((backoff || 2) * 2, 30);
                wlog(`后端异常退出 code=${code} sig=${sig} —— ${backoff} 秒后退避重拉`);
                setTimeout(() => restart('异常退出退避'), backoff * 1000);
            } else {
                backoff = 0;
                wlog(`后端进程正常退出 code=${code} —— 3 秒后重拉`);
                setTimeout(() => restart('子进程退出'), 3000);
            }
        });
        setTimeout(() => { spawning = false; }, 10000);
    };
    setInterval(() => {
        probe().then((up) => {
            if (up) { fails = 0; return; }
            fails++;
            wlog(`探测失败（第 ${fails} 次）`);
            if (fails >= 3) {
                console.error('[main] 看门狗：后端连续无响应多次，ASR/TTS/LLM 都不可用'
                    + '（详见 logs/backend_watch.log）');
            }
            restart('探测失败');
        });
    }, 5000);
}

app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-logging')

function ensureConfigExists() {
    try {
        if (fs.existsSync(CONFIG_PATH())) return;

        console.log('配置文件不存在，尝试从默认配置创建');
        if (fs.existsSync(DEFAULT_CONFIG_PATH())) {
            fs.copyFileSync(DEFAULT_CONFIG_PATH(), CONFIG_PATH());
            console.log('已从默认配置创建新的配置文件');
            return;
        }

        const basicConfig = {
            "llm": {
                "api_key": "YOUR_LLM_API_KEY",
                "api_url": "https://api.zhizengzeng.com/v1",
                "model": "claude-3-5-sonnet-20240620",
                "system_prompt": ""
            },
            "tts": {
                "url": "http://127.0.0.1:5000",
                "language": "zh"
            },
            "asr": {
                "vad_url": "ws://127.0.0.1:1000/v1/ws/vad",
                "asr_url": "http://127.0.0.1:1000/v1/upload_audio"
            },
            "memory": {
                "file_path": "memory/text_database.txt",
                "check_url": "http://127.0.0.1:7878/check"
            },
            "vision": {
                "enabled": true,
                "free": {
                    "enabled": true,
                    "model": "glm-4v-flash",
                    "fps": 1.0
                }
            },
            "ui": {
                "intro_text": "你好。",
                "model_scale": 560
            },
            "context": {
                "enable_limit": true,
                "max_messages": 8
            }
        };

        fs.writeFileSync(CONFIG_PATH(), JSON.stringify(basicConfig, null, 2), 'utf8');
        console.log('已创建基本配置文件');
        fs.writeFileSync(DEFAULT_CONFIG_PATH(), JSON.stringify(basicConfig, null, 2), 'utf8');
        console.log('已创建默认配置备份');
    } catch (error) {
        console.error('确保配置文件存在时出错:', error);
    }
}

let visionPump = null

function startVisionPump() {
    try {
        if (visionPump) return
        let cfg = {}
        try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8')) } catch (e) {   }
        const v = cfg.vision || {}
        const free = v.free || {}
        const enabled = (v.enabled !== false) && (free.enabled === true)
        const _excludeSelf = (free.exclude_self_window !== false)
        visionPump = new VisionFramePump({
            backendUrl: `http://${BACKEND_HOST}:${BACKEND_PORT}/v1/vision_frame`,
            enabled,
            fps: Number(free.fps) || 1.0,
            changeThreshold: Number(free.change_threshold) || 0.06,
            protectWindows: _excludeSelf ? (on) => {
                const _apply = (w) => {
                    try {
                        if (w && !w.isDestroyed() && typeof w.setContentProtection === 'function') {
                            w.setContentProtection(!!on)
                        }
                    } catch (e) {   }
                }
                _apply(mainWindowRef)
                _apply(chatMonitor && chatMonitor.win)
                const _roomVisibleUntil = Number(global.__roomVisualUntil || 0)
                if (!(on && Date.now() < _roomVisibleUntil)) {
                    _apply(chatRoom && chatRoom.win)
                }
            } : null
        })
        visionPump.start()
        _diagLog(`[vision] 连续注视已启动 enabled=${enabled} fps=${visionPump.fps} `
            + `changeThreshold=${visionPump.changeThreshold} `
            + `key=${free.api_key ? '已配置' : '未配置(后端将拒绝理解)'}`)
    } catch (e) {
        
        _diagLog(`[vision] 连续注视启动失败: ${e && e.message}`)
    }
}

function stopVisionPump() {
    try { if (visionPump) { visionPump.stop(); visionPump = null } } catch (e) {   }
}

function updateLive2DModelPath() {
    console.log('开始更新Live2D模型路径...')
    const appDir = app.getAppPath()
    const modelDir = path.join(appDir, '2D')

    if (!fs.existsSync(modelDir)) {
        console.log('2D文件夹不存在，不进行更新')
        return
    }

    let modelFiles = []
    try {
        const files = fs.readdirSync(modelDir)
        modelFiles = files.filter(file => file.endsWith('.model3.json'))

        if (modelFiles.length === 0) {
            console.log('2D文件夹中没有找到.model3.json文件，不进行更新')
            return
        }

        const selectedModelFile = modelFiles[0]
        const relativeModelPath = path.join('2D', selectedModelFile).replace(/\\/g, '/') 
        console.log(`找到模型文件: ${relativeModelPath}`)

        const appJsPath = path.join(appDir, 'js', 'app.js')
        let jsContent = fs.readFileSync(appJsPath, 'utf8')

        const pattern = /const model = await PIXI\.live2d\.Live2DModel\.from\("([^"]*)"\);/
        const replacement = `const model = await PIXI.live2d.Live2DModel.from("${relativeModelPath}");`

        if (pattern.test(jsContent)) {
            jsContent = jsContent.replace(pattern, replacement)
            fs.writeFileSync(appJsPath, jsContent, 'utf8')
            console.log(`成功更新 js/app.js 中的模型路径为: ${relativeModelPath}`)
        } else {
            console.log('在app.js中没有找到匹配的模型加载代码行')
        }
    } catch (err) {
        console.error('更新Live2D模型路径时出错:', err)
    }
}


let nameWindow = null
function openNameWindow() {
    if (nameWindow && !nameWindow.isDestroyed()) {
        nameWindow.show()
        nameWindow.focus()
        return nameWindow
    }
    let prefill = readNameFromFile()
    if (!prefill) {
        try {
            const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'))
            prefill = (cfg.user && cfg.user.name) || ''
        } catch (e) {   }
    }

    nameWindow = new BrowserWindow({
        width: 470,
        height: 268,
        resizable: false,
        maximizable: false,
        frame: false,
        center: true,
        show: false,
        alwaysOnTop: true,
        backgroundColor: '#0d1212',
        title: 'Neuro - Your name',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
    })
    nameWindow.setMenu(null)
    nameWindow.loadFile(path.join(__dirname, 'settings.html'))
    nameWindow.once('ready-to-show', () => {
        nameWindow.show()
        nameWindow.focus()
        nameWindow.webContents.send('prefill-name', prefill)
    })
    nameWindow.on('closed', () => { nameWindow = null })
    return nameWindow
}

function nameFilePath() {
    return path.join(appPath(), 'memory', 'user_name.txt')
}

function readNameFromFile() {
    try {
        const f = nameFilePath()
        if (!fs.existsSync(f)) return ''
        const line = String(fs.readFileSync(f, 'utf8')).split(/\r?\n/)[0] || ''
        return line.replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim().slice(0, 24)
    } catch (e) { return '' }
}

function applyUserName(rawName) {
    const name = String(rawName || '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24)
    
    try {
        const f = nameFilePath()
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(f, name + '\n', 'utf8')
        _diagLog('[name] 用户名字已写入 memory/user_name.txt: ' + JSON.stringify(name))
    } catch (e) {
        _diagLog('[name] 写 user_name.txt 失败: ' + (e && e.message))
    }
    try {
        const cfg = fs.existsSync(CONFIG_PATH()) ? JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8')) : {}
        if (!cfg.user) cfg.user = {}
        cfg.user.name = name
        cfg.user.asked = !!name
        fs.writeFileSync(CONFIG_PATH(), JSON.stringify(cfg, null, 2), 'utf8')
    } catch (e) {
        _diagLog('[name] 写回 config.json 失败: ' + (e && e.message))
    }

    if (name) {
        const body = JSON.stringify({ name })
        const req = require('http').request({
            host: BACKEND_HOST,
            port: BACKEND_PORT,
            path: '/v1/user/name',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 2500,
        }, (res) => { res.resume() })
        req.on('error', () => {   })
        req.on('timeout', () => { try { req.destroy() } catch (e) {   } })
        req.end(body)
    }

    const win = mainWindowRef
    if (win && !win.isDestroyed()) {
        const js = 'if (window.voiceChat && window.voiceChat.setUserName) {'
            + 'window.voiceChat.setUserName(' + JSON.stringify(name) + ');'
            + 'if (' + JSON.stringify(name) + ') window.voiceChat.showSubtitle("Got it. I\'ll call you " + '
            + JSON.stringify(name) + ', 6000); }'
        win.webContents.executeJavaScript(js).catch(() => {   })
    }
    if (nameWindow && !nameWindow.isDestroyed()) nameWindow.close()
    return name
}

ipcMain.on('save-user-name', (_e, raw) => { applyUserName(raw) })
ipcMain.on('close-name-window', () => {
    if (nameWindow && !nameWindow.isDestroyed()) nameWindow.close()
})

function ensureTopMost(win) {
    if (!win || typeof win.isDestroyed !== 'function' || win.isDestroyed()) return;
    try {
        if (!win.isAlwaysOnTop()) {
            win.setAlwaysOnTop(true, 'screen-saver')
        }
    } catch (e) {   }
}

function createWindow() {
    const primaryDisplay = screen.getPrimaryDisplay()
    const { width: screenWidth, height: screenHeight } = primaryDisplay.size
    const win = new BrowserWindow({
        width: screenWidth,
        height: screenHeight,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        focusable: false,
        type: 'desktop',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true,
            zoomFactor: 1.0,
            enableWebSQL: true,
            backgroundThrottling: false
        },
        resizable: true,
        movable: true,
        skipTaskbar: false,
        maximizable: false
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setMenu(null)
    win.setPosition(0, 0)
    win.loadFile('index.html')
    win.on('minimize', (event) => {
        event.preventDefault()
        win.restore()
    })
    win.on('will-move', (event, newBounds) => {
        const { width, height } = primaryDisplay.workAreaSize
        if (newBounds.x < 0 || newBounds.y < 0 ||
            newBounds.x + newBounds.width > width ||
            newBounds.y + newBounds.height > height) {
            event.preventDefault()
        }
    })
    win.on('blur', () => {
        ensureTopMost(win)
    })
    win.on('close', (e) => {
        if (_quitting || _allowQuit) return;
        e.preventDefault();
        console.log('[main] 窗口被关闭 → 转为道别+总结流程');
        farewellAndQuit();
    })
    
    const topTimer = setInterval(() => {
        if (win.isDestroyed()) { clearInterval(topTimer); return; }
        ensureTopMost(win)
    }, 2000)
    globalShortcut.register('F12', () => {
        win.webContents.openDevTools();
    });

    return win
}

app.whenReady().then(() => {
    _diagLog(`[portable] 模式=${_portableUserData ? 'ON (userData→' + _portableUserData + ')' : 'OFF (数据写系统目录)'} `
        + `appPath=${app.getAppPath()} python=${resolvePython() || '★未找到'}`);

    ensureConfigExists();

    
    updateLive2DModelPath();

    
    ensureBackend().then(() => {
        startBackendWatchdog();
        const mainWindow = createWindow();
        mainWindowRef = mainWindow;

        
        
        try {
            const _n = readNameFromFile()
            if (!_n) {
                try {
                    const f = nameFilePath()
                    fs.mkdirSync(path.dirname(f), { recursive: true })
                    if (!fs.existsSync(f)) fs.writeFileSync(f, '', 'utf8')
                } catch (e) {   }
                setTimeout(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        const msg = 'Write my name in memory/user_name.txt - one line is enough.'
                        mainWindow.webContents.executeJavaScript(
                            'window.voiceChat && window.voiceChat.showSubtitle(' + JSON.stringify(msg) + ', 9000)'
                        ).catch(() => {   })
                    }
                }, 6000)
            }
        } catch (e) {   }
        try { globalShortcut.register('Control+Alt+N', () => openNameWindow()) } catch (e) {   }

        try {
            let _cfg = {}
            try { _cfg = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8')) } catch (e) {   }
            const _ui = _cfg.ui || {}
            const _free = (_cfg.vision || {}).free || {}
            chatMonitor = new ChatMonitor({
                protect: false,
                getExitLines: () => _exitLines.slice(),
                onClose: () => {
                    _diagLog('[monitor] CLOSE NEURO 被点击 → 写入退出请求标记')
                    _exitBegin()
                    _exitSay('CLOSE NEURO 触发来源：控制台窗口')
                    try {
                        const flag = path.join(appPath(), '.quit_request')
                        fs.writeFileSync(flag, 'quit', 'utf8')
                        _diagLog('[monitor] 已写入 .quit_request，等待主进程轮询退出')
                    } catch (e) {
                        _diagLog('[monitor] 写退出标记失败: ' + (e && e.message))
                        farewellAndQuit()
                    }
                }
            })
            if (_ui.show_chat_monitor !== false) {
                chatMonitor.show()
                _diagLog('[monitor] 对话/后台窗口已打开（仅抓帧瞬间排除捕获）')
            } else {
                _diagLog('[monitor] show_chat_monitor=false：后台窗口不显示，但 IPC（终端/文件/进程）仍已注册')
            }
            if (_ui.show_chat_room !== false) {
                let _humanity = null
                let _roomBg = ''
                try {
                    const _cfg2 = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'))
                    _humanity = (_cfg2.llm || {}).humanity ?? null
                    _roomBg = (_cfg2.ui || {}).chat_room_bg || ''
                } catch (e) {   }
                const _setHumanity = (rawVal) => {
                    try {
                        const v = Math.min(1, Math.max(0, Number(rawVal)))
                        if (!Number.isFinite(v)) { _diagLog('[room] 人格值非法: ' + rawVal); return }
                        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'))
                        if (!cfg.llm) cfg.llm = {}
                        cfg.llm.humanity = v
                        if (fs.existsSync(CONFIG_PATH())) {
                            fs.copyFileSync(CONFIG_PATH(), `${CONFIG_PATH()}.bak`)
                        }
                        fs.writeFileSync(CONFIG_PATH(), JSON.stringify(cfg, null, 2), 'utf8')
                        _diagLog(`[room] 拟人程度已写回 config.json: ${v.toFixed(2)}（下一轮对话生效）`)
                        if (chatRoom && chatRoom.win && !chatRoom.win.isDestroyed()) {
                            chatRoom.win.webContents.executeJavaScript(
                                'window.__setPersonaValue && window.__setPersonaValue(' + v + ')'
                            ).catch(() => {})
                        }
                    } catch (e) {
                        _diagLog('[room] 写回拟人程度失败: ' + (e && e.message))
                    }
                }
                const _injectBg = (url) => {
                    if (chatRoom && chatRoom.win && !chatRoom.win.isDestroyed()) {
                        chatRoom.win.webContents.executeJavaScript(
                            'window.__setBg && window.__setBg(' + JSON.stringify(url) + ')'
                        ).catch(() => {})
                    }
                }
                const _saveBgCfg = (url) => {
                    try {
                        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'))
                        if (!cfg.ui) cfg.ui = {}
                        cfg.ui.chat_room_bg = url || ''
                        if (fs.existsSync(CONFIG_PATH())) {
                            fs.copyFileSync(CONFIG_PATH(), `${CONFIG_PATH()}.bak`)
                        }
                        fs.writeFileSync(CONFIG_PATH(), JSON.stringify(cfg, null, 2), 'utf8')
                    } catch (e) {   }
                }
                const _pickBg = (arg) => {
                    if (arg === 'none') {
                        _saveBgCfg('')
                        _injectBg('')
                        _diagLog('[room] 背景已清除')
                        return
                    }
                    const imgExts = [
                        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif'] }
                    ]
                    const picked = dialog.showOpenDialogSync(chatRoom && chatRoom.win, {
                        title: '选择聊天房背景图片（30% 不透明度，底色保留）',
                        properties: ['openFile'],
                        filters: imgExts
                    })
                    const src = picked && picked[0]
                    if (!src) return
                    try {
                        const assetsDir = path.join(appPath(), 'assets')
                        if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true })
                        const ext = (path.extname(src) || '.png').toLowerCase().replace(/[^.a-z0-9]/g, '')
                        const dest = path.join(assetsDir, 'chatroom-bg-' + Date.now() + ext)
                        fs.copyFileSync(src, dest)
                        
                        try {
                            const stale = fs.readdirSync(assetsDir).filter((f) =>
                                /^chatroom-bg(-[0-9]+)?\.(png|jpg|jpeg|bmp|webp|gif)$/i.test(f)
                                && path.join(assetsDir, f) !== dest
                            )
                            for (const f of stale) {
                                fs.unlinkSync(path.join(assetsDir, f))
                            }
                            if (stale.length) _diagLog('[room] 已清理旧背景图: ' + stale.join(', '))
                        } catch (e) {   }
                        const parts = dest.split(path.sep).map(encodeURIComponent)
                        parts[0] = parts[0].replace(/%3A/i, ':')
                        const url = 'file:///' + parts.join('/')
                        _saveBgCfg(url)
                        _injectBg(url)
                        _diagLog('[room] 背景已设置: ' + dest)
                    } catch (e) {
                        _diagLog('[room] 设置背景失败: ' + (e && e.message))
                    }
                }
                chatRoom = new ChatRoom({
                    protect: false,
                    getExitLines: () => (_exitReportStarted
                        ? _exitLines.slice(_exitReportFrom)
                        : []),
                    humanity: _humanity,
                    bgUrl: _roomBg,
                    onSetHumanity: _setHumanity,
                    onPickBg: _pickBg,
                    onClose: () => {
                        _diagLog('[room] CLOSE NEURO 被点击 → 写入退出请求标记')
                        _exitBegin()
                        _exitSay('CLOSE NEURO 触发来源：聊天房窗口')
                        try {
                            const flag = path.join(appPath(), '.quit_request')
                            fs.writeFileSync(flag, 'quit', 'utf8')
                        } catch (e) {
                            _diagLog('[room] 写退出标记失败: ' + (e && e.message))
                            farewellAndQuit()
                        }
                    }
                })
                chatRoom.show()
                _diagLog('[room] 聊天房已创建（启动同步打开）')
                if (chatMonitor && chatRoom.win) {
                    ChatMonitor.addTermListener(chatRoom.win)
                }
                _diagLog('[room] 聊天房已同步打开')
            }
        } catch (e) {
            _diagLog('[monitor] 打开失败（不影响桌宠）: ' + (e && e.message))
        }

        registerShortcuts(mainWindow);
        startVisionPump();
    });
})

function registerShortcuts(mainWindow) {
    globalShortcut.register('CommandOrControl+,', () => {
        openConfigEditor(mainWindow);
    });

    globalShortcut.register('CommandOrControl+Q', () => {
        app.quit();
    });

    globalShortcut.register('CommandOrControl+T', () => {
        mainWindow.webContents.send('toggle-text-input');
        console.log('[main] Ctrl+T → 切换文本输入框');
    });

    globalShortcut.register('CommandOrControl+Alt+Q', () => {
        console.log('[main] Ctrl+Alt+Q → 道别并总结退出');
        farewellAndQuit();
    });

    globalShortcut.register('CommandOrControl+Shift+L', () => {
        if (chatMonitor) chatMonitor.toggle();
        console.log('[main] Ctrl+Shift+L → 切换后台/对话窗口');
    });

}

app.on('window-all-closed', () => {
    
    if (chatMonitor) { try { chatMonitor.hide() } catch (e) {   } }
    if (chatRoom) { try { chatRoom.hide() } catch (e) {   } }
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

function flushMemoryBeforeQuit() {
    if (_quitting) return;
    _quitting = true;
    const win = mainWindowRef;
    if (!win || win.isDestroyed()) {
        hardExit(0);
        return;
    }

    _exitBegin();
    _exitSay('CLOSE NEURO 触发来源：键盘 / 系统退出请求（只总结、不道别）');
    console.log('[main] 收到退出请求 → 先让渲染进程总结本段对话');

    
    _quitTimer = setTimeout(() => {
        console.log('[main] 等待总结超时，强制退出');
        _exitSay('等待总结超时，强制结束。');
        _writeExitReport();
        _openExitReport();
        hardExit(0);
    }, 25000);

    try {
        win.webContents.send('flush-memory');
    } catch (e) {
        console.error('[main] 通知渲染进程失败', e);
        hardExit(0);
    }
}

function farewellAndQuit() {
    if (_quitting) return;
    const win = mainWindowRef;
    if (!win || win.isDestroyed()) {
        hardExit(0);
        return;
    }
    _quitting = true;
    console.log('[main] 道别并总结退出');

    _exitBegin();
    _exitSay('[1/3] 后端检查：' + (backendProcess ? '本进程拉起的后端在线' : '外部后端 / 直连模式')
        + '，本段对话将由桌宠 AI 总结。');
    _exitSay('[2/3] 桌宠正在运行，开始道别 → 总结 → 退出流程。');
    _exitSay('[3/3] 已收到退出请求，正在等她总结本段对话...');

    _quitTimer = setTimeout(() => {
        console.log('[main] 道别/总结超时，强制退出');
        _exitSay('等待超过 30 秒，强制结束（记忆可能未完整总结）。');
        _writeExitReport();
        _openExitReport();
        hardExit(0);
    }, 30000);

    try {
        win.webContents.send('farewell-and-quit');
    } catch (e) {
        console.error('[main] 发送道别指令失败', e);
        hardExit(0);
    }
}

try {
    if (fs.existsSync(QUIT_FLAG_FILE())) {
        fs.unlinkSync(QUIT_FLAG_FILE());
        console.log('[main] 已清理上次残留的退出请求标记');
    }
    setInterval(() => {
        if (!fs.existsSync(QUIT_FLAG_FILE())) return;
        try { fs.unlinkSync(QUIT_FLAG_FILE()); } catch (e) {   }
        console.log('[main] 检测到退出请求文件 → 道别并总结退出');
        if (!_exitReportStarted) {
            _exitBegin();
            _exitSay('CLOSE NEURO 触发来源：桌面 close Neuro.bat（.quit_request 标记）');
        }
        farewellAndQuit();
    }, 1000);
} catch (e) {   }

ipcMain.on('exit-memory-text', (e, payload) => {
    _exitMemoryReported = true;
    try {
        const texts = (payload && Array.isArray(payload.texts)) ? payload.texts : [];
        const stats = (payload && payload.stats) || {};
        _exitSay('[4/4] 记忆总结完成：新增 ' + (stats.added ?? 0) + ' 条，'
            + '遗忘后保留 ' + (stats.kept ?? 0) + ' 条（删除 ' + (stats.removed ?? 0) + ' 条）');
        if (texts.length) {
            _exitSay('---------- 本轮存入的印象片段（内部背景，不主动提起） ----------');
            texts.forEach((t, i) => _exitSay('  ' + (i + 1) + '. ' + String(t)));
        } else {
            _exitSay('  本轮没有新增印象（对话太少 / 总结被跳过）。');
        }
        _writeExitReport();
    } catch (err) {   }
});


ipcMain.on('memory-flushed', () => {
    console.log('[main] 渲染进程已总结完成 → 退出');
    if (_quitTimer) { clearTimeout(_quitTimer); _quitTimer = null; }
    if (!_exitMemoryReported) {
        _exitSay('[4/4] 本轮总结未返回记忆文本（后端离线 / 总结超时 / 对话过短）。');
    }
    _exitSay('完成。本轮印象已静默存入外部记忆库，不会在下次开场主动提起。');
    _writeExitReport();
    _openExitReport();

    _allowQuit = true;
    try {
        BrowserWindow.getAllWindows().forEach(w => {
            try { w.removeAllListeners('close') } catch (e2) {   }
        });
    } catch (e2) {   }

    setTimeout(() => app.quit(), 600);
});


function _writeExitReport() {
    try {
        const f = path.join(__dirname, '..', 'logs', 'last_exit.txt');
        fs.mkdirSync(path.dirname(f), { recursive: true });
        const head = '桌宠退出报告 · ' + new Date().toLocaleString('zh-CN') + '\n'
            + '（完整历史：logs/exit_summary.txt）\n\n';
        const body = _exitLines.slice(_exitReportFrom).join('\n');
        fs.writeFileSync(f, head + body + '\n', 'utf8');
    } catch (e) {   }
}

function _openExitReport() {
    if (_reportOpened) return;
    _reportOpened = true;
    try {
        const f = path.join(__dirname, '..', 'logs', 'last_exit.txt');
        if (fs.existsSync(f)) require('electron').shell.openPath(f);
    } catch (e) {   }
}
let _reportOpened = false;
let _exitMemoryReported = false;

app.on('before-quit', (e) => {
    if (_allowQuit) return;
    stopVisionPump();
    if (_quitting) {
        e.preventDefault();
        return;
    }
    flushMemoryBeforeQuit();
});

function openConfigEditor(parentWindow) {
    if (!fs.existsSync(CONFIG_PATH())) {
        dialog.showMessageBox(parentWindow, {
            type: 'error',
            title: '错误',
            message: '配置文件不存在',
            detail: '找不到配置文件。应用将尝试创建一个新的配置文件。',
            buttons: ['确定']
        });
        ensureConfigExists();
        return;
    }

    try {
        require('electron').shell.openPath(CONFIG_PATH());
    } catch (error) {
        console.error('打开配置文件失败:', error);
        dialog.showMessageBox(parentWindow, {
            type: 'error',
            title: '错误',
            message: '无法打开配置文件',
            detail: error.message,
            buttons: ['确定']
        });
    }
}

ipcMain.on('tts-progress', (_e, p) => {
    try {
        global.__neuroTtsProgress = (p && typeof p === 'object') ? p : null
    } catch (e) {   }
    if (chatRoom && chatRoom.win && !chatRoom.win.isDestroyed()) {
        try { chatRoom.win.webContents.send('tts:progress', p) } catch (e) {   }
    }
})

ipcMain.on('room-focus', () => {
    if (!chatRoom || !chatRoom.win || chatRoom.win.isDestroyed()) {
        _diagLog('[room] 双击立绘但聊天房未开（show_chat_room=false？）')
        return
    }
    try {
        if (chatRoom.win.isMinimized && chatRoom.win.isMinimized()) chatRoom.win.restore()
        chatRoom.win.show()
        chatRoom.win.focus()
        chatRoom.win.moveTop()
        _diagLog('[room] 双击立绘 → 聊天房拉到前台')
    } catch (e) {
        _diagLog('[room] 拉前台失败: ' + (e && e.message))
    }
})


ipcMain.on('window-move', (event, { mouseX, mouseY }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const [currentX, currentY] = win.getPosition()
    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize
    let newX = currentX + mouseX
    let newY = currentY + mouseY
    newX = Math.max(-win.getBounds().width + 100, Math.min(newX, screenWidth - 100))
    newY = Math.max(-win.getBounds().height + 100, Math.min(newY, screenHeight - 100))
    win.setPosition(newX, newY)
})

ipcMain.on('set-ignore-mouse-events', (event, { ignore, options }) => {
    BrowserWindow.fromWebContents(event.sender).setIgnoreMouseEvents(ignore, options)
})

ipcMain.on('request-top-most', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win.setAlwaysOnTop(true, 'screen-saver')
})

ipcMain.handle('save-config', async (event, configData) => {
    try {
        if (fs.existsSync(CONFIG_PATH())) {
            fs.copyFileSync(CONFIG_PATH(), `${CONFIG_PATH()}.bak`);
        }
        fs.writeFileSync(CONFIG_PATH(), JSON.stringify(configData, null, 2), 'utf8');

        const result = await dialog.showMessageBox({
            type: 'info',
            title: '配置已保存',
            message: '配置已成功保存',
            detail: '需要重启应用以应用新配置。现在重启应用吗？',
            buttons: ['是', '否'],
            defaultId: 0
        });

        if (result.response === 0) {
            app.relaunch();
            hardExit();
        }

        return { success: true };
    } catch (error) {
        console.error('保存配置失败:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-config', async (event) => {
    try {
        if (!fs.existsSync(CONFIG_PATH())) {
            ensureConfigExists();
        }
        const configData = fs.readFileSync(CONFIG_PATH(), 'utf8');
        return { success: true, config: JSON.parse(configData) };
    } catch (error) {
        console.error('获取配置失败:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('open-config-editor', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    openConfigEditor(win);
    return { success: true };
});

ipcMain.handle('update-live2d-model', async (event) => {
    try {
        updateLive2DModelPath()

        
        const win = BrowserWindow.fromWebContents(event.sender)
        win.reload()

        return { success: true, message: '模型已更新，页面将重新加载' }
    } catch (error) {
        console.error('手动更新模型时出错:', error)
        return { success: false, message: `更新失败: ${error.message}` }
    }
})

const ROOM_OPS_MAIN = new Set([
    'cpp_set_code', 'cpp_get_code', 'cpp_visual_inspect', 'cpp_run', 'cpp_debug'
])

function _roomSend(payload) {
    if (!chatRoom || !chatRoom.win || chatRoom.win.isDestroyed()) {
        return { ok: false, msg: '聊天房窗口还没打开' }
    }
    try {
        chatRoom.win.webContents.send('room:user', payload)
        return { ok: true, msg: '已送到聊天房' }
    } catch (e) {
        return { ok: false, msg: '转发失败: ' + (e && e.message) }
    }
}

ipcMain.handle('room-command', async (_e, payload) => {
    try {
        if (!payload || typeof payload !== 'object') return { ok: false, msg: '指令格式不对' }
        const op = String(payload.op || '')
        if (!ROOM_OPS_MAIN.has(op)) return { ok: false, msg: '不认识的房间操作：' + op }
        const code = typeof payload.code === 'string' ? payload.code : ''
        const r = _roomSend({
            op: op,
            code: code,
            mode: op === 'cpp_debug' ? 'debug' : 'run'
        })
        if (!r.ok) return r

        if (op === 'cpp_set_code') {
            const lines = code.split('\n').length
            _diagLog(`[room] cpp_set_code ${lines} 行 / ${code.length} 字符 → #cppeditor`)
            return { ok: true, msg: `代码已写入 C++ 编辑器：${lines} 行 / ${code.length} 字符。` }
        }
        if (op === 'cpp_run' || op === 'cpp_debug') {
            _diagLog(`[room] ${op}`)
            return { ok: true, msg: op === 'cpp_debug' ? '已点 ⚙ DEBUG 编译。' : '已点 ▶ RUN 编译运行。' }
        }
        if (op === 'cpp_visual_inspect') {
            global.__roomVisualUntil = Date.now() + 12000
            try {
                chatRoom.win.setContentProtection(false)
                chatRoom.win.show()
                chatRoom.win.moveTop()
            } catch (e) {   }
            _diagLog('[room] cpp_visual_inspect 聊天房对视觉可见 12s')
            return { ok: true, msg: '聊天房 C++ 面板已对视觉可见 12 秒，可检查全局代码。' }
        }
        if (op === 'cpp_get_code') {
            try {
                const cur = await chatRoom.win.webContents.executeJavaScript(
                    "(function(){var e=document.getElementById('cppeditor');return e?e.value:''})()")
                const s = String(cur || '')
                return { ok: true, msg: `编辑器当前 ${s.split('\n').length} 行 / ${s.length} 字符。` }
            } catch (e) {
                return { ok: true, msg: '编辑器读回失败，已改用后端镜像。' }
            }
        }
        return { ok: true, msg: '已送到聊天房' }
    } catch (e) {
        return { ok: false, msg: '房间指令异常: ' + (e && e.message) }
    }
})

ipcMain.on('desktop-log', (_e, msg) => {
    _diagLog('[desktop] ' + String(msg || '').slice(0, 300))
})

ipcMain.handle('desktop-command', async (event, payload) => {
    try {
        if (!payload || typeof payload !== 'object') {
            return { ok: false, msg: '指令格式不对' }
        }
        
        const v = CommandRouter.validateDesktopCmd({ op: payload.op, args: payload.args })
        if (!v.ok) {
            return { ok: false, msg: v.error }
        }
        if (v.needsConfirm) {
            try {
                const { response } = await dialog.showMessageBox({
                    type: 'question',
                    buttons: ['取消', '执行'],
                    defaultId: 1,
                    title: '确认操作',
                    message: `即将执行 ${v.op}（${JSON.stringify(v.args)}），确定吗？`,
                })
                if (response !== 1) {
                    return { ok: false, msg: '用户已取消' }
                }
            } catch (e) {
                return { ok: false, msg: '未能确认' }
            }
        }
        const built = CommandRouter.buildPowerShellCommand(v.op, v.args)
        if (!built.ok) {
            return { ok: false, msg: built.error }
        }
        _diagLog(`[desktop] 执行 ${v.op} ${JSON.stringify(v.args)}`)
        const psExe = path.join(process.env.SystemRoot || 'C:\\Windows',
            'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        if (!fs.existsSync(psExe)) {
            _diagLog(`[desktop] 找不到脚本宿主: ${psExe}`)
            return { ok: false, msg: '找不到脚本宿主: ' + psExe }
        }
        return await new Promise((resolve) => {
            const ps = spawn(psExe, ['-NoProfile', '-NonInteractive', '-Command', built.command], {
                windowsHide: true,
            })
            let out = ''
            let err = ''
            let settled = false
            let killTimer = null
            const done = (r) => {
                if (settled) return
                settled = true
                clearTimeout(killTimer)
                _diagLog(`[desktop] 结果 ${v.op} ok=${r.ok} ${String(r.msg || '').slice(0, 160)}`)
                resolve(r)
            }
            killTimer = setTimeout(() => {
                try { ps.kill() } catch (e) {   }
                done({ ok: false, msg: '执行超时（12s）' })
            }, 12000)
            ps.stdout.on('data', (d) => { out += d.toString() })
            ps.stderr.on('data', (d) => { err += d.toString() })
            ps.on('error', (e) => done({ ok: false, msg: '启动脚本宿主失败: ' + e.message }))
            ps.on('close', (code) => {
                const text = out.trim()
                const verify = /VERIFY\s+(\d+),(\d+)/.exec(text)
                const miss = /MISS\s+(-?\d+),(-?\d+)/.exec(text)
                let ok
                let msg
                if (v.op === 'get_cursor_pos') {
                    ok = code === 0 && /^\d+,\d+$/.test(text)
                    msg = text
                } else if (verify) {
                    ok = true
                    msg = `光标已落到 ${verify[1]},${verify[2]}（视觉闭环校验通过）`
                } else if (miss) {
                    ok = false
                    msg = `光标没对上，实际落在 ${miss[1]},${miss[2]}（3 次修正后仍超 12px）`
                } else {
                    ok = code === 0 && /OK|SENT/.test(text)
                    msg = ok ? 'done' : `退出码 ${code} ${err.slice(0, 300)}`.trim()
                }
                done({ ok, msg })
            })
        })
    } catch (e) {
        return { ok: false, msg: '主进程执行异常: ' + (e && e.message ? e.message : e) }
    }
})

function killBackendIfOwned() {
    if (!backendProcess || backendProcess.killed) return;
    const pid = backendProcess.pid
    
    
    try {
        const http = require('http')
        const req = http.request({ host: '127.0.0.1', port: 6006, path: '/v1/bridge/stop',
            method: 'POST', timeout: 4000 }, () => {})
        req.on('error', () => {})
        req.end()
    } catch (e) {   }
    const { spawnSync } = require('child_process')
    const t0 = Date.now()
    let stopped = false
    while (Date.now() - t0 < 2500) {
        if (backendProcess.exitCode !== null || backendProcess.killed) { stopped = true; break }
        try {
            const out = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/NH'],
                { windowsHide: true, encoding: 'utf8' })
            if (!out.stdout || !out.stdout.includes(String(pid))) { stopped = true; break }
        } catch (e) { stopped = true; break }
        spawnSync('ping', ['127.0.0.1', '-n', '2'], { windowsHide: true, stdio: 'ignore' })
    }
    if (!stopped) {
        try {
            const { execFileSync } = require('child_process')
            execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'],
                { windowsHide: true, stdio: 'ignore' })
        } catch (e) {
            try { backendProcess.kill() } catch (e2) {}
        }
    }
}
app.on('will-quit', () => {
    killBackendIfOwned();
});



process.on('SIGINT', () => {
    console.log('[main] 收到 SIGINT，先存记忆再退出');
    flushMemoryBeforeQuit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
    }
})
