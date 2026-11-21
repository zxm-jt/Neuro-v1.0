const fs = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')
const { spawn, exec } = require('child_process')
const { BrowserWindow, screen, ipcMain } = require('electron')
const sysMonitor = require('./sys-monitor')
const browserTabs = require('./browser-tabs')

const _CONSOLE_HTML_FILE = path.join(os.tmpdir(), 'neuro_console_' + process.pid + '.html')

function _validateConsoleHtml(html) {
    const blocks = [...String(html).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
    if (!blocks.length) throw new Error('Console HTML 里没有 <script> 块')
    blocks.forEach((code, i) => {
        try {
            new Function(code)
        } catch (e) {
            throw new Error('Console HTML 第 ' + (i + 1) + ' 个 <script> 语法错误: ' + e.message)
        }
    })
    if (!/__render\s*=/.test(html)) throw new Error('Console HTML 里缺少 window.__render 定义')
    return true
}

function _writeConsoleHtml() {
    const html = _loadConsoleHtml()
    if (!html) {
        try {
            const errHtml = '<!doctype html><meta charset="utf-8">' +
                '<body style="background:#11151b;color:#ff6b6b;font:14px/1.6 Consolas,monospace;' +
                'padding:20px;white-space:pre-wrap"><h3 style="color:#ff6b6b">Console 页面加载失败</h3>' +
                '读不到 js/console.html</body>'
            fs.writeFileSync(_CONSOLE_HTML_FILE, errHtml, 'utf8')
        } catch (e2) {   }
        return null
    }
    try {
        _validateConsoleHtml(html)
        fs.writeFileSync(_CONSOLE_HTML_FILE, html, 'utf8')
        return _CONSOLE_HTML_FILE
    } catch (e) {
        console.error('[monitor] Console HTML 自检失败:', e && e.message)
        try {
            const errHtml = '<!doctype html><meta charset="utf-8">' +
                '<body style="background:#11151b;color:#ff6b6b;font:14px/1.6 Consolas,monospace;' +
                'padding:20px;white-space:pre-wrap"><h3 style="color:#ff6b6b">Console 页面自检失败</h3>' +
                String(e && e.message).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</body>'
            fs.writeFileSync(_CONSOLE_HTML_FILE, errHtml, 'utf8')
        } catch (e2) {   }
        return null
    }
}

const CHAT_LOG = () => path.join(__dirname, '..', 'backend', 'chat_log.txt')
const DIAG_LOG = () => path.join(__dirname, '..', 'logs', 'backend_diag.log')

const NOISE_RE = /探针:|subtitle_join|\[mouth\]/

const SESSION_MARK_RE = /^\[.*\]\s*session:/

function fileSize(file) {
    try { return fs.statSync(file).size } catch (e) { return 0 }
}

function readLines(file, filter) {
    try {
        if (!fs.existsSync(file)) return []
        const txt = fs.readFileSync(file, 'utf8')
        let lines = txt.split(/\r?\n/).filter((l) => l.trim())
        if (filter) lines = lines.filter(filter)
        return lines
    } catch (e) {
        return ['[monitor] 读日志失败: ' + (e && e.message)]
    }
}

function lastSessionMarkIndex(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
        if (SESSION_MARK_RE.test(lines[i])) {
            if (i >= lines.length - 1) continue
            return i
        }
    }
    return -1
}


function tailLines(file, limit, filter, fromOffset = 0) {
    try {
        if (!fs.existsSync(file)) return []
        const size = fileSize(file)
        let start = fromOffset || 0
        if (start > size) start = 0
        let txt
        if (start > 0) {
            const fd = fs.openSync(file, 'r')
            let atLineStart = true
            try {
                const prev = Buffer.alloc(1)
                fs.readSync(fd, prev, 0, 1, start - 1)
                atLineStart = prev[0] === 0x0A
                const buf = Buffer.alloc(size - start)
                fs.readSync(fd, buf, 0, buf.length, start)
                txt = buf.toString('utf8')
            } finally { fs.closeSync(fd) }
            if (!atLineStart) {
                const nl = txt.indexOf('\n')
                txt = nl >= 0 ? txt.slice(nl + 1) : ''
            }
        } else {
            txt = fs.readFileSync(file, 'utf8')
        }
        let lines = txt.split(/\r?\n/).filter((l) => l.trim())
        if (filter) lines = lines.filter(filter)
        return lines.slice(-limit)
    } catch (e) {
        return ['[monitor] 读日志失败: ' + (e && e.message)]
    }
}

function getJson(url, timeoutMs = 1200) {
    return new Promise((resolve) => {
        let done = false
        const finish = (v) => { if (!done) { done = true; resolve(v) } }
        try {
            const req = http.get(url, (res) => {
                let body = ''
                res.on('data', (d) => { body += d.toString() })
                res.on('end', () => {
                    try { finish(JSON.parse(body)) } catch (e) { finish(null) }
                })
            })
            req.setTimeout(timeoutMs, () => { req.destroy(); finish(null) })
            req.on('error', () => finish(null))
        } catch (e) { finish(null) }
    })
}

const CONSOLE_HTML_PATH = path.join(__dirname, 'console.html')
const HALO_ENGINE_PATH = path.join(__dirname, 'halo-engine.js')
function _loadConsoleHtml() {
    try {
        let html = fs.readFileSync(CONSOLE_HTML_PATH, 'utf8')
        const m = /<!--\s*INLINE:halo-engine\.js\s*-->/.test(html)
        if (m) {
            try {
                const engine = fs.readFileSync(HALO_ENGINE_PATH, 'utf8')
                html = html.replace(/<!--\s*INLINE:halo-engine\.js\s*-->/, '<script>\n' + engine + '\n</script>')
            } catch (e2) {
                console.error('[monitor] 读取 halo-engine.js 失败:', e2 && e2.message)
                html = html.replace(/<!--\s*INLINE:halo-engine\.js\s*-->/, '')
            }
        }
        return html
    } catch (e) {
        console.error('[monitor] 读取 console.html 失败:', e && e.message)
        return null
    }
}

class ChatMonitor {
    constructor(opts = {}) {
        this.win = null
        this.timer = null
        this.protect = opts.protect !== false
        this.alwaysOnTop = opts.alwaysOnTop === true
        this.backendUrl = opts.backendUrl || 'http://127.0.0.1:6006/v1/vision/status'
        
        this.onClose = opts.onClose || null
        this.getExitLines = opts.getExitLines || null
        this._diagOffset = 0
        this._shell = null
        this._shellWindow = null
        this._termListeners = new Set()
        ChatMonitor._instance = this
        this._sysSnapshot = null
        this._sysSnapshotTime = 0
        this._browserTabs = { detected: false, browser: '', tabs: [], hint: '' }
        this._browserTabsTime = 0
        this._sysRefreshing = false
        this._browserRefreshing = false
        this._registerTerminalIpc()
        this._registerControlIpc()     
    }

    static addTermListener(win) {
        const inst = ChatMonitor._instance
        if (!inst || !win || win.isDestroyed?.()) return
        inst._termListeners.add(win)
        if (inst._shell && inst._shell.exitCode === null && !win.isDestroyed()) {
            try { win.webContents.send('term:data', '\r\n[neuro] 已连接到共享终端\r\n') } catch (e) {   }
        }
    }
    static removeTermListener(win) {
        const inst = ChatMonitor._instance
        if (!inst) return
        inst._termListeners.delete(win)
    }

    _registerTerminalIpc() {
        if (this._ipcRegistered) return
        this._ipcRegistered = true

        ipcMain.handle('term:start', () => {
            if (this._shell && this._shell.exitCode === null) return true
            try {
                const shell = spawn(
                    'powershell.exe',
                    ['-NoExit', '-NoLogo', '-Command',
                     '[Console]::InputEncoding=[Console]::OutputEncoding=' +
                     '$OutputEncoding=[Text.UTF8Encoding]::new();' +
                     '$PSDefaultParameterValues["*:Encoding"]="utf8"'],
                    {
                        cwd: os.homedir(),
                        windowsHide: true,
                        env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' })
                    }
                )
                shell.stdout.setEncoding('utf8')
                shell.stderr.setEncoding('utf8')
                shell.stdout.on('data', (d) => this._pushTermData(d))
                shell.stderr.on('data', (d) => this._pushTermData(d))
                shell.on('exit', (code) => this._pushTermExit(code))
                shell.on('error', (err) => {
                    this._pushTermData('\r\n[neuro] 终端启动失败: ' + (err && err.message) + '\r\n')
                    this._pushTermExit(-1)
                })
                this._shell = shell
                this._shellWindow = this.win
                return true
            } catch (e) {
                this._pushTermData('\r\n[neuro] spawn 异常: ' + (e && e.message) + '\r\n')
                return false
            }
        })

        ipcMain.handle('term:write', (_e, s) => {
            const sh = this._shell
            if (!sh || sh.exitCode !== null) return false
            try { sh.stdin.write(String(s || '')) } catch (e) { return false }
            return true
        })

        ipcMain.handle('term:kill', () => {
            const sh = this._shell
            if (sh && sh.exitCode === null) {
                try { sh.kill() } catch (e) {   }
                this._shell = null
                this._shellWindow = null
            }
            return true
        })

        ipcMain.handle('term:running', () => !!this._shell && this._shell.exitCode === null)

        if (!this._cppIpcRegistered) {
            this._cppIpcRegistered = true
            ipcMain.handle('cpp:probe', () => {
                return new Promise((resolve) => {
                    const probe = spawn('g++', ['--version'], {
                        windowsHide: true,
                        env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' })
                    })
                    let out = ''
                    probe.stdout.setEncoding('utf8')
                    probe.stderr.setEncoding('utf8')
                    probe.stdout.on('data', (d) => { out += d })
                    probe.stderr.on('data', (d) => { out += d })
                    probe.on('error', () => resolve(null))
                    probe.on('close', () => {
                        const m = /g\+\+.*?(\d+\.\d+\.\d+)/.exec(out) || /g\+\+.*?(\d+\.\d+)/.exec(out)
                        resolve(m ? m[0] : (out.trim() || null))
                    })
                    setTimeout(() => { try { probe.kill() } catch (e) {   } }, 4000)
                })
            })
            ipcMain.handle('cpp:compile', (_e, src, mode) => {
                return this._compileCpp(String(src || ''), mode === 'debug' ? 'debug' : 'run')
            })
            ipcMain.handle('cpp:stdin', (_e, text) => {
                const proc = this._cppProc
                if (!proc || !proc.stdin || proc.stdin.destroyed || proc.exitCode != null) return false
                try {
                    proc.stdin.write(String(text || '') + '\n', 'utf8')
                    return true
                } catch (e) { return false }
            })
        }
        this._registerFsIpc()
    }

    _compileCpp(src, mode) {
        return new Promise((resolve) => {
            if (!src.trim()) { this._pushTermData('\r\n[neuro] (空源码)\r\n'); resolve({ ok: false }); return }
            const isDebug = (mode === 'debug')
            const tmp = os.tmpdir()
            const tag = 'neuro_cpp_' + Date.now() + '_' + Math.floor(Math.random() * 100000)
            const srcPath = path.join(tmp, tag + '.cpp')
            const exePath = path.join(tmp, tag + '.exe')
            try { fs.writeFileSync(srcPath, src, 'utf8') } catch (e) {
                this._pushTermData('\r\n[neuro] 写源码失败: ' + (e && e.message) + '\r\n')
                resolve({ ok: false }); return
            }
            const flags = isDebug ? ['-std=c++17', '-g', '-O0'] : ['-std=c++17', '-O2']
            this._pushTermData('\r\n[neuro] 编译中 (g++ ' + flags.join(' ') + ' ' + path.basename(srcPath) + ')...\r\n')
            const gpp = spawn('g++', flags.concat(['-o', exePath, srcPath]), {
                windowsHide: true,
                env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' })
            })
            let errOut = ''
            gpp.stdout.setEncoding('utf8')
            gpp.stderr.setEncoding('utf8')
            gpp.stdout.on('data', (d) => { errOut += d })
            gpp.stderr.on('data', (d) => { errOut += d })
            gpp.on('error', (err) => {
                this._pushTermData('\r\n[neuro] 无法调用 g++：' + (err && err.message) + '\r\n')
                this._pushTermData(' 请确认已安装 MinGW 并把 bin 目录加入 PATH（VSCode 的 mingw64\\bin 即可）\r\n')
                resolve({ ok: false })
            })
            gpp.on('close', (code) => {
                if (code !== 0) {
                    this._pushTermData(errOut || ('\r\n[neuro] 编译失败，退出码 ' + code + '\r\n'))
                    resolve({ ok: false })
                    return
                }
                this._pushTermData('\r\n[neuro] 编译成功，运行: ' + path.basename(exePath) + '\r\n')
                const exe = spawn(exePath, [], {
                    windowsHide: true,
                    cwd: tmp,
                    env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' })
                })
                this._cppProc = exe
                let runOut = ''
                exe.stdout.setEncoding('utf8')
                exe.stderr.setEncoding('utf8')
                exe.stdout.on('data', (d) => { runOut += d; this._pushTermData(d) })
                exe.stderr.on('data', (d) => { runOut += d; this._pushTermData(d) })
                exe.on('error', (err) => {
                    this._cppProc = null
                    this._pushTermData('\r\n[neuro] 运行失败: ' + (err && err.message) + '\r\n')
                })
                const killTimer = setTimeout(() => {
                    try { exe.kill() } catch (e) {   }
                    this._cppProc = null
                    this._pushTermData('\r\n[neuro] 运行超时（15s），已终止\r\n')
                }, 15000)
                exe.on('close', (rc) => {
                    this._cppProc = null
                    clearTimeout(killTimer)
                    this._pushTermData('\r\n[neuro] 程序退出，退出码 ' + rc + '（exit 回到 PS 模式）\r\n')
                    resolve({ ok: true, code: rc })
                })
            })
            setTimeout(() => {
                try { gpp.kill() } catch (e) {   }
                this._pushTermData('\r\n[neuro] 编译超时（15s），已终止\r\n')
            }, 15000)
        })
    }

    _registerFsIpc() {
        if (this._fsIpcRegistered) return
        this._fsIpcRegistered = true
        ipcMain.handle('fs:list', (_e, dir) => {
            try {
                const target = (dir && String(dir).trim())
                    ? String(dir).trim() : path.join(os.homedir(), 'Desktop')
                if (!fs.existsSync(target)) {
                    return { ok: false, error: '目录不存在: ' + target }
                }
                const st = fs.statSync(target)
                if (!st.isDirectory()) return { ok: false, error: '不是文件夹: ' + target }
                const entries = fs.readdirSync(target, { withFileTypes: true })
                const dirs = [], files = []
                for (const en of entries) {
                    if (en.name.startsWith('.')) continue
                    try {
                        if (en.isDirectory()) dirs.push(en.name)
                        else files.push(en.name)
                    } catch (e) {   }
                }
                dirs.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
                files.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
                return { ok: true, path: target, dirs, files }
            } catch (e) {
                return { ok: false, error: (e && e.message) || '列出目录失败' }
            }
        })
        ipcMain.handle('fs:mkdir', (_e, dir, name) => {
            try {
                const target = String(dir || '').trim()
                const nm = String(name || '').trim()
                if (!target || !nm || /[<>:"/\\|?*]/.test(nm) || nm === '.' || nm === '..') {
                    return { ok: false, error: '文件夹名不合法' }
                }
                fs.mkdirSync(path.join(target, nm), { recursive: false })
                return { ok: true }
            } catch (e) {
                return { ok: false, error: (e && e.code === 'EEXIST') ? '已存在同名文件夹' : ((e && e.message) || '创建失败') }
            }
        })
        ipcMain.handle('fs:delete', (_e, dir, name) => {
            try {
                const target = String(dir || '').trim()
                const nm = String(name || '').trim()
                if (!target || !nm || nm === '.' || nm === '..') return { ok: false, error: '路径不合法' }
                const full = path.join(target, nm)
                if (!fs.existsSync(full)) return { ok: false, error: '不存在: ' + nm }
                const { execFile } = require('child_process')
                const ps = spawn('powershell.exe', [
                    '-NoProfile', '-NonInteractive', '-Command',
                    'Add-Type -AssemblyName Microsoft.VisualBasic;' +
                    '[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory("' +
                    full.replace(/"/g, '""') + '", "OnlyErrorDialogs", "SendToRecycleBin")'
                ], { windowsHide: true })
                ps.on('close', (code) => {
                    if (code !== 0) {
                        const ps2 = spawn('powershell.exe', [
                            '-NoProfile', '-NonInteractive', '-Command',
                            'Add-Type -AssemblyName Microsoft.VisualBasic;' +
                            '[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile("' +
                            full.replace(/"/g, '""') + '", "OnlyErrorDialogs", "SendToRecycleBin")'
                        ], { windowsHide: true })
                        ps2.on('close', (code2) => {
                            this._pushTermData('\r\n[neuro] 删除 ' + nm + (code2 === 0 ? '（已进回收站）' : ' 失败') + '\r\n')
                        })
                    } else {
                        this._pushTermData('\r\n[neuro] 删除 ' + nm + '（已进回收站）\r\n')
                    }
                })
                return { ok: true }
            } catch (e) {
                return { ok: false, error: (e && e.message) || '删除失败' }
            }
        })
        ipcMain.handle('fs:open', (_e, dir, name) => {
            try {
                const target = String(dir || '').trim()
                const nm = String(name || '').trim()
                const full = nm ? path.join(target, nm) : target
                if (!fs.existsSync(full)) return { ok: false, error: '不存在: ' + (nm || target) }
                const { shell } = require('electron')
                shell.openPath(full)
                return { ok: true }
            } catch (e) {
                return { ok: false, error: (e && e.message) || '打开失败' }
            }
        })
        
        ipcMain.handle('fs:read', (_e, dir, name) => {
            try {
                const target = String(dir || '').trim()
                const nm = String(name || '').trim()
                const full = nm ? path.join(target, nm) : target
                if (!fs.existsSync(full)) return { ok: false, error: '不存在: ' + (nm || target) }
                const st = fs.statSync(full)
                if (st.isDirectory()) return { ok: false, error: '是文件夹，不是文件' }
                if (st.size > 512 * 1024) return { ok: false, error: '文件过大（>512KB），不预览' }
                const ext = path.extname(nm).toLowerCase().replace('.', '')
                const TEXT_EXT = new Set(['txt','md','markdown','cpp','h','hpp','c','cs','cc','java','py','js','mjs','cjs','ts','jsx','tsx','json','xml','yml','yaml','html','htm','css','scss','less','go','rs','sh','bat','user','ps1','sql','ini','conf','cfg','log','toml','svg','vue','rb','php','swift','kt','lua','r','pl','dart','gradle','properties','env','gitignore','dockerfile'])
                if (!TEXT_EXT.has(ext)) return { ok: false, error: '非文本文件（.' + (ext || '无扩展名') + '），不支持预览' }
                const buf = fs.readFileSync(full)
                let text
                if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
                    text = buf.slice(3).toString('utf8')
                } else {
                    text = buf.toString('utf8')
                    if (text.indexOf('\uFFFD') >= 0) text = buf.toString('latin1')
                }
                
                return { ok: true, name: nm, text }
            } catch (e) {
                return { ok: false, error: (e && e.message) || '读取失败' }
            }
        })
        ipcMain.handle('fs:root', async () => {
            const { dialog } = require('electron')
            const picked = dialog.showOpenDialogSync(this.win, {
                title: '选择文件夹作为文件树根目录',
                properties: ['openDirectory']
            })
            return picked && picked[0] ? { ok: true, path: picked[0] } : { ok: false, path: '' }
        })
        ipcMain.handle('fs:drives', async () => {
            try {
                const drives = []
                for (let c = 65; c <= 90; c++) {
                    const letter = String.fromCharCode(c)
                    const root = letter + ':\\'
                    try {
                        if (fs.existsSync(root)) drives.push(root)
                    } catch (e) {   }
                }
                return { ok: true, drives }
            } catch (e) {
                return { ok: false, error: (e && e.message) || '枚举盘符失败', drives: [] }
            }
        })
        ipcMain.handle('win:minimize', (e) => {
            try {
                const w = BrowserWindow.fromWebContents(e.sender)
                if (w && !w.isDestroyed()) w.minimize()
                return { ok: true }
            } catch (err) { return { ok: false } }
        })
        ipcMain.handle('win:close', (e) => {
            try {
                const w = BrowserWindow.fromWebContents(e.sender)
                if (w && !w.isDestroyed()) w.close()
                return { ok: true }
            } catch (err) { return { ok: false } }
        })
    }

    _registerControlIpc() {
        if (this._controlIpcRegistered) return
        this._controlIpcRegistered = true

        ipcMain.handle('sys:procs', async () => {
            try {
                const out = await new Promise((resolve) => {
                    exec('powershell.exe -NoProfile -Command ' +
                        '"Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 30 ' +
                        "ProcessName,Id,@{N='Mem';E={[math]::Round($_.WorkingSet64/1MB)}}," +
                        "@{N='CPU';E={[math]::Round($_.CPU)}} | ConvertTo-Json -Compress\"",
                        { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 },
                        (err, stdout) => resolve(stdout || ''))
                })
                if (!out) return { ok: false, procs: [] }
                let arr = JSON.parse(out.trim())
                if (!Array.isArray(arr)) arr = [arr]
                return {
                    ok: true,
                    procs: arr.map(p => ({ name: p.ProcessName, pid: p.Id, mem: p.Mem, cpu: p.CPU }))
                }
            } catch (e) {
                return { ok: false, procs: [], error: (e && e.message) || '列进程失败' }
            }
        })

        ipcMain.handle('sys:kill', async (_e, pid) => {
            const p = parseInt(pid)
            if (!p || p <= 0 || p === process.pid) return { ok: false, error: '非法 PID' }
            try {
                await new Promise((resolve) => {
                    exec(`powershell.exe -NoProfile -Command "Stop-Process -Id ${p} -Force"`,
                        { windowsHide: true, timeout: 5000 }, () => resolve())
                })
                return { ok: true }
            } catch (e) {
                return { ok: false, error: (e && e.message) || '结束进程失败' }
            }
        })

        ipcMain.handle('sys:launch', async (_e, target) => {
            if (!target) return { ok: false, error: '空目标' }
            try {
                
                if (/^https?:\/\//i.test(target)) {
                    const { shell } = require('electron')
                    await shell.openExternal(target)
                } else {
                    const child = spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process "${target}"`],
                        { windowsHide: true })
                    child.on('error', () => {})
                }
                return { ok: true }
            } catch (e) {
                return { ok: false, error: (e && e.message) || '启动失败' }
            }
        })

        ipcMain.handle('sys:reload', async () => {
            try {
                this._sysSnapshot = await sysMonitor.snapshot()
                this._sysSnapshotTime = Date.now()
                this._browserTabs = await browserTabs.detectTabs()
                this._browserTabsTime = Date.now()
                return { ok: true }
            } catch (e) {
                return { ok: false, error: (e && e.message) || '刷新失败' }
            }
        })
    }

    
    _pushTermData(text) {
        const w = this._shellWindow
        if (w && !w.isDestroyed()) {
            try { w.webContents.send('term:data', String(text)) } catch (e) {   }
        }
        for (const lw of this._termListeners) {
            if (lw && !lw.isDestroyed()) {
                try { lw.webContents.send('term:data', String(text)) } catch (e) {   }
            } else {
                this._termListeners.delete(lw)
            }
        }
    }

    _pushTermExit(code) {
        const w = this._shellWindow
        if (w && !w.isDestroyed()) {
            try { w.webContents.send('term:exit', code) } catch (e) {   }
        }
        for (const lw of this._termListeners) {
            if (lw && !lw.isDestroyed()) {
                try { lw.webContents.send('term:exit', code) } catch (e) {   }
            } else {
                this._termListeners.delete(lw)
            }
        }
        if (this._shell && this._shell.exitCode !== null) this._shell = null
    }

    
    _cleanupShell() {
        const sh = this._shell
        if (sh && sh.exitCode === null) {
            try { sh.kill() } catch (e) {   }
        }
        this._shell = null
        this._shellWindow = null
    }

    show() {
        if (this.win && !this.win.isDestroyed()) { this.win.show(); return }
        const disp = screen.getPrimaryDisplay()
        const area = disp.workArea || { x: 0, y: 0, width: 1280, height: 720 }
        const w = Math.min(880, Math.round(area.width * 0.62))
        const h = Math.min(620, Math.round(area.height * 0.68))
        const win = new BrowserWindow({
            width: w,
            height: h,
            x: Math.max(area.x, area.x + area.width - w - 16),
            y: area.y + 16,
            title: 'Neuro Console',
            backgroundColor: '#11151b',
            alwaysOnTop: this.alwaysOnTop,
            skipTaskbar: false,
            resizable: true,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'console-preload.js')
            }
        })
        win.maximize()
        if (this.alwaysOnTop) win.setAlwaysOnTop(true, 'floating')
        win.on('page-title-updated', (e, title) => {
            const m = /^__NEURO_CONSOLE__:(pin|close):(.+)$/.exec(String(title || ''))
            if (m) {
                e.preventDefault()
                if (m[1] === 'pin') {
                    win.setAlwaysOnTop(m[2] === '1', 'floating')
                } else if (m[1] === 'close') {
                    if (this.onClose) {
                        try { this.onClose(m[2]) } catch (e2) {   }
                    }
                }
            }
        })
        try {
            if (this.protect && typeof win.setContentProtection === 'function') {
                win.setContentProtection(true)
            }
        } catch (e) {   }
        win.setMenu(null)
        const htmlFile = _writeConsoleHtml()
        if (htmlFile) {
            win.loadFile(htmlFile)
        } else {
            const _fallback = '<!doctype html><meta charset="utf-8">' +
                '<body style="background:#11151b;color:#ff6b6b;font:14px/1.6 Consolas,monospace;' +
                'padding:20px"><h3>Console 页面无法加载</h3>' +
                '<p>读不到 js/console.html，且临时文件写入失败。</p>' +
                '<p>后端日志仍可在 logs/backend_diag.log 查看；对话在 backend/chat_log.txt。</p></body>'
            win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(_fallback))
        }
        win.webContents.once('did-finish-load', () => {
            try { win.webContents.executeJavaScript('window.__bindControls && window.__bindControls()') }
            catch (e) {   }
        })
        win.on('closed', () => {
            this.win = null
            this._cleanupShell()
            this._termListeners.delete(win)
        })
        this.win = win
        this._tick()
        this.timer = setInterval(() => this._tick(), 1000)
    }

    hide() {
        if (this.timer) { clearInterval(this.timer); this.timer = null }
        if (this.win && !this.win.isDestroyed()) this.win.close()
        this.win = null
        this._cleanupShell()
    }

    toggle() {
        if (this.win && !this.win.isDestroyed()) this.hide(); else this.show()
    }

    async _tick() {
        if (!this.win || this.win.isDestroyed() || this.win.webContents.isLoading()) return
        const status = await getJson(this.backendUrl)
        const allChat = readLines(CHAT_LOG())
        const mark = lastSessionMarkIndex(allChat)
        const chat = (mark >= 0 ? allChat.slice(mark + 1) : allChat).slice(-60)
        const diagSize = fileSize(DIAG_LOG())
        const diagFrom = this._diagOffset > diagSize ? 0 : this._diagOffset
        const diag = tailLines(DIAG_LOG(), 70, (l) => !NOISE_RE.test(l), diagFrom)
        this._diagOffset = diagSize
        let exitLines = []
        try {
            if (typeof this.getExitLines === 'function') {
                const got = this.getExitLines()
                if (Array.isArray(got)) exitLines = got
            }
        } catch (e) {   }
        const nowMs = Date.now()
        if (!this._sysSnapshot || nowMs - this._sysSnapshotTime > 2000) {
            this._refreshSysAsync()
        }
        const sys = this._sysSnapshot
        if (!this._browserTabs || nowMs - this._browserTabsTime > 5000) {
            this._refreshBrowserAsync()
        }
        const payload = {
            chat,
            diag,
            exitLines,
            backend: !!status,
            vision: !!(status && (status.active || status.running)),
            visionModel: status ? (status.model || 'watching') : '',
            frames: status ? (status.frames ?? status.frames_received ?? null) : null,
            observations: status ? (status.observations ?? status.observation_count ?? null) : null,
            protected: this.protect,
            tts: (function(){
                const t = global.__neuroTtsProgress
                if (!t || typeof t !== 'object') return null
                const ts = Number(t.ts) || 0
                return (Date.now() - ts < 3000) ? t : null
            })(),
            sys: sys,
            browser: this._browserTabs,
            time: new Date().toTimeString().slice(0, 8)
        }
        try {
            await this.win.webContents.executeJavaScript(
                'window.__render(' + JSON.stringify(payload) + ')')
        } catch (e) {   }
    }

    _refreshSysAsync() {
        if (this._sysRefreshing) return
        this._sysRefreshing = true
        sysMonitor.snapshot().then((snap) => {
            this._sysSnapshot = snap
            this._sysSnapshotTime = Date.now()
        }).catch((e) => {   })
          .finally(() => { this._sysRefreshing = false })
    }

    _refreshBrowserAsync() {
        if (this._browserRefreshing) return
        this._browserRefreshing = true
        browserTabs.detectTabs().then((tabs) => {
            this._browserTabs = tabs
            this._browserTabsTime = Date.now()
        }).catch((e) => {   })
          .finally(() => { this._browserRefreshing = false })
    }
}

module.exports = { ChatMonitor }
