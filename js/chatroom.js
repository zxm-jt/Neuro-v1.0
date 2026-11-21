const fs = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')
const { BrowserWindow, screen } = require('electron')

const _ROOM_HTML_FILE = path.join(os.tmpdir(), 'neuro_room_' + process.pid + '.html')
const ROOM_HTML_PATH = path.join(__dirname, 'chatroom.html')
const TERM_PRELOAD = path.join(__dirname, 'console-preload.js')

function _validateRoomHtml(html) {
    const blocks = [...String(html).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
    if (!blocks.length) throw new Error('ChatRoom HTML 里没有 <script> 块')
    blocks.forEach((code, i) => {
        try { new Function(code) }
        catch (e) { throw new Error('ChatRoom HTML 第 ' + (i + 1) + ' 个 <script> 语法错误: ' + e.message) }
    })
    if (!/__render\s*=/.test(html)) throw new Error('ChatRoom HTML 里缺少 window.__render 定义')
    return true
}

function _writeRoomHtml() {
    try {
        const html = fs.readFileSync(ROOM_HTML_PATH, 'utf8')
        _validateRoomHtml(html)
        fs.writeFileSync(_ROOM_HTML_FILE, html, 'utf8')
        return _ROOM_HTML_FILE
    } catch (e) {
        console.error('[room] ChatRoom HTML 准备失败:', e && e.message)
        try {
            const errHtml = '<!doctype html><meta charset="utf-8">' +
                '<body style="background:#0d1212;color:#a05050;font:14px/1.6 Consolas,monospace;' +
                'padding:20px;white-space:pre-wrap"><h3>ChatRoom 加载失败</h3>' +
                String(e && e.message).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</body>'
            fs.writeFileSync(_ROOM_HTML_FILE, errHtml, 'utf8')
        } catch (e2) {   }
        return _ROOM_HTML_FILE
    }
}

const CHAT_LOG = () => path.join(__dirname, '..', 'backend', 'chat_log.txt')
const SESSION_MARK_RE = /^\[.*\]\s*session:/

function readLines(file, filter) {
    try {
        if (!fs.existsSync(file)) return []
        const txt = fs.readFileSync(file, 'utf8')
        let lines = txt.split(/\r?\n/).filter((l) => l.trim())
        if (filter) lines = lines.filter(filter)
        return lines
    } catch (e) {
        return []
    }
}
function lastSessionMarkIndex(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
        if (SESSION_MARK_RE.test(lines[i])) {
            if (i >= lines.length - 1) continue;
            return i
        }
    }
    
    return -1
}







function buildRoomChat(lines) {
    const cur = lastSessionMarkIndex(lines)
    if (cur < 0) return []
    return lines.slice(cur + 1).filter((l) => !SESSION_MARK_RE.test(l)).slice(-60)
}
function getJson(url, timeoutMs = 1200) {
    return new Promise((resolve) => {
        let done = false
        const finish = (v) => { if (!done) { done = true; resolve(v) } }
        try {
            const req = http.get(url, (res) => {
                let body = ''
                res.on('data', (d) => { body += d.toString() })
                res.on('end', () => { try { finish(JSON.parse(body)) } catch (e) { finish(null) } })
            })
            req.setTimeout(timeoutMs, () => { req.destroy(); finish(null) })
            req.on('error', () => finish(null))
        } catch (e) { finish(null) }
    })
}

class ChatRoom {
    constructor(opts = {}) {
        this.win = null
        this.timer = null
        this.protect = opts.protect !== false
        this.alwaysOnTop = opts.alwaysOnTop === true
        this.backendUrl = opts.backendUrl || 'http://127.0.0.1:6006/v1/vision/status'
        this.onClose = opts.onClose || null
        this.onSetHumanity = opts.onSetHumanity || null
        
        this.humanity = opts.humanity != null ? opts.humanity : null
        this.onPickBg = opts.onPickBg || null
        
        this.bgUrl = opts.bgUrl || ''
        this.getExitLines = opts.getExitLines || null
    }

    show() {
        if (this.win && !this.win.isDestroyed()) {
            this.win.show()
            this._focusOnce()
            return
        }
        this._quitting = false
        this._forceClose = false
        const disp = screen.getPrimaryDisplay()
        const area = disp.workArea || { x: 0, y: 0, width: 1280, height: 720 }
        const w = Math.min(1240, Math.round(area.width * 0.82))
        const h = Math.min(900, Math.round(area.height * 0.82))
        const win = new BrowserWindow({
            width: w,
            height: h,
            x: area.x + Math.round((area.width - w) / 2),
            y: area.y + Math.round((area.height - h) / 2),
            title: 'Neuro Chat Room',
            backgroundColor: '#0d1212',
            alwaysOnTop: this.alwaysOnTop,
            skipTaskbar: false,
            resizable: true,
            frame: false,
            show: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: TERM_PRELOAD
            }
        })
        const targetW = area.width
        const targetH = area.height
        const startW = Math.max(240, Math.round(targetW * 0.18))
        const startH = Math.max(180, Math.round(targetH * 0.18))
        win.setBounds({
            x: area.x,
            y: area.y + area.height - startH,
            width: startW,
            height: startH
        })
        win.show()
        this._animateOpen(win, area, startW, startH)
        win.on('close', (e) => {
            if (this._quitting || this._forceClose) return
            e.preventDefault()
            this._quitting = true
            if (this.onClose) this.onClose()
            else win.destroy()
        })
        win.on('page-title-updated', (e, title) => {
            const m = /^__NEURO_ROOM__:(humanity|pin|close|bg):(.+)$/.exec(String(title || ''))
            if (m) {
                e.preventDefault()
                
                const _arg = String(m[2]).replace(/:\d+$/, '')
                if (m[1] === 'humanity') {
                    if (this.onSetHumanity) this.onSetHumanity(_arg)
                } else if (m[1] === 'pin') {
                    win.setAlwaysOnTop(_arg === '1', 'floating')
                } else if (m[1] === 'close') {
                    this._quitting = true
                    if (this.onClose) {
                        try { this.onClose() } catch (e2) {   }
                    }
                    if (!this.onClose && this.win && !this.win.isDestroyed()) {
                        try { this.win.destroy() } catch (e2) {   }
                    }
                } else if (m[1] === 'bg') {
                    
                    if (this.onPickBg) this.onPickBg(_arg)
                }
            }
        })
        try {
            if (this.protect && typeof win.setContentProtection === 'function') {
                win.setContentProtection(true)
            }
        } catch (e) {   }
        win.setMenu(null)
        const htmlFile = _writeRoomHtml()
        if (htmlFile) win.loadFile(htmlFile)
        win.webContents.once('did-finish-load', () => {
            try { win.moveTop(); win.focus() } catch (e) {   }
            try { win.webContents.executeJavaScript('window.__bindControls && window.__bindControls()') }
            catch (e) {   }
            
            if (this.humanity != null) {
                try {
                    win.webContents.executeJavaScript(
                        'window.__setPersonaValue && window.__setPersonaValue(' + Number(this.humanity) + ')')
                } catch (e) {   }
            }
            if (this.bgUrl) {
                try {
                    win.webContents.executeJavaScript(
                        "window.__setBg && window.__setBg(" + JSON.stringify(this.bgUrl) + ")")
                } catch (e) {   }
            }
        })
        win.on('closed', () => {
            this.win = null
            try {
                const { ChatMonitor } = require('./chat-monitor.js')
                ChatMonitor.removeTermListener(win)
            } catch (e) {   }
        })
        this.win = win
        this._tick()
        this.timer = setInterval(() => this._tick(), 10000)
        this._startChatStream()
        this._focusOnce()
    }

    _animateOpen(win, area, startW, startH) {
        const targetW = area.width
        const targetH = area.height
        const tx = area.x
        const ty = area.y
        const anchorX = area.x
        const anchorY = area.y + area.height
        const DUR = 520
        const t0 = Date.now()
        const ease = (p) => 1 - Math.pow(1 - p, 3)
        const step = () => {
            if (!win || win.isDestroyed()) return
            const p = Math.min(1, (Date.now() - t0) / DUR)
            const e = ease(p)
            const w = Math.round(startW + (targetW - startW) * e)
            const h = Math.round(startH + (targetH - startH) * e)
            const x = anchorX
            const y = anchorY - h
            try {
                win.setBounds({ x, y, width: w, height: h })
            } catch (err) {   }
            if (p < 1) {
                setTimeout(step, 33)
            } else {
                try {
                    win.setBounds({ x: tx, y: ty, width: targetW, height: targetH })
                    win.maximize()
                } catch (err) {   }
                this._focusOnce()
            }
        }
        step()
    }

    _focusOnce() {
        [180, 600, 1200, 2200].forEach((delay) => {
            setTimeout(() => {
                if (this.win && !this.win.isDestroyed()) {
                    try { this.win.moveTop() } catch (e) {   }
                    try { this.win.focus() } catch (e) {   }
                }
            }, delay)
        })
    }

    hide() {
        if (this.timer) { clearInterval(this.timer); this.timer = null }
        this._stopChatStream()
        this._forceClose = true
        if (this.win && !this.win.isDestroyed()) this.win.close()
        this.win = null
    }

    toggle() {
        if (this.win && !this.win.isDestroyed()) this.hide(); else this.show()
    }

    _startChatStream() {
        
        this._sseClosed = false
        if (this._sseTimer) { clearTimeout(this._sseTimer); this._sseTimer = null }
        if (this._sseReq) { try { this._sseReq.destroy() } catch (e) {} this._sseReq = null }
        const url = String(this.backendUrl || '').replace(/\/v1\/vision\/status$/, '') +
            '/v1/chat_stream?tail=0'
        const scheduleRetry = () => {
            if (this._sseClosed) return
            const wait = Math.min(15000, 500 * Math.pow(2, (this._sseRetry = (this._sseRetry || 0) + 1)))
            this._sseTimer = setTimeout(() => this._startChatStream(), wait)
        }
        try {
            const http = require('http')
            const req = http.get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
                if (res.statusCode !== 200) {
                    res.resume()
                    scheduleRetry()
                    return
                }
                this._sseRetry = 0
                res.setEncoding('utf8')
                let buf = ''
                res.on('data', (chunk) => {
                    buf += chunk
                    let idx
                    while ((idx = buf.indexOf('\n\n')) >= 0) {
                        const block = buf.slice(0, idx)
                        buf = buf.slice(idx + 2)
                        if (!block.startsWith('data: ')) continue
                        this._tickSoon()
                    }
                })
                res.on('end', scheduleRetry)
                res.on('error', scheduleRetry)
            })
            req.on('error', scheduleRetry)
            req.setTimeout(120000, () => { try { req.destroy() } catch (e) {} })
            this._sseReq = req
        } catch (e) {
            scheduleRetry()
        }
    }

    _stopChatStream() {
        this._sseClosed = true
        if (this._sseTimer) { clearTimeout(this._sseTimer); this._sseTimer = null }
        if (this._sseReq) { try { this._sseReq.destroy() } catch (e) {} this._sseReq = null }
        if (this._tickSoonTimer) { clearTimeout(this._tickSoonTimer); this._tickSoonTimer = null }
    }

    
    _tickSoon() {
        if (this._tickSoonTimer) return
        this._tickSoonTimer = setTimeout(() => {
            this._tickSoonTimer = null
            this._tick().catch(() => {   })
        }, 80)
    }

    async _tick() {        if (!this.win || this.win.isDestroyed() || this.win.webContents.isLoading()) return
        const status = await getJson(this.backendUrl)
        const allChat = readLines(CHAT_LOG())
        const chat = buildRoomChat(allChat)
        let exitLines = []
        try {
            if (typeof this.getExitLines === 'function') {
                const got = this.getExitLines()
                if (Array.isArray(got)) exitLines = got
            }
        } catch (e) {   }
        const payload = {
            chat,
            exitLines,
            backend: !!status,
            vision: !!(status && (status.active || status.running)),
            visionModel: status ? (status.model || 'watching') : '',
            frames: status ? (status.frames ?? status.frames_received ?? null) : null,
            observations: status ? (status.observations ?? status.observation_count ?? null) : null,
            time: new Date().toTimeString().slice(0, 8),
            interruptAt: (typeof global.__neuroLastInterruptAt === 'number')
                ? global.__neuroLastInterruptAt : 0,
            tts: (function(){
                const t = global.__neuroTtsProgress
                if (!t || typeof t !== 'object') return null
                const ts = Number(t.ts) || 0
                return (Date.now() - ts < 800) ? t : null
            })()
        }
        try {
            await this.win.webContents.executeJavaScript(
                'window.__render(' + JSON.stringify(payload) + ')')
        } catch (e) {   }
    }
}

module.exports = { ChatRoom }
