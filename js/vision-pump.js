const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const http = require('http')
const { desktopCapturer, screen } = require('electron')

const _vdiag = (...args) => {
  try {
    
    const f = path.join(__dirname, '..', 'logs', 'backend_diag.log')
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.appendFileSync(f, '[' + new Date().toTimeString().slice(0, 8) + '] [vision] ' + args.join(' ') + '\n')
  } catch (e) {   }
}

class VisionFramePump {
  constructor(opts = {}) {
    this.backendUrl = opts.backendUrl || 'http://127.0.0.1:6006/v1/vision_frame'
    this.fps = Number(opts.fps || 1.0)
    this.maxEdge = Number(opts.maxEdge || 1280)
    this.quality = Number(opts.quality || 62)
    this.changeThreshold = Number(opts.changeThreshold || 0.06)
    this.enabled = !!opts.enabled
    this.protectWindows = typeof opts.protectWindows === 'function'
        ? opts.protectWindows : null

    this.timer = null
    this.running = false
    this._lastHash = null
    this._lastThumb = null
    this._framesSent = 0
    this._framesSkipped = 0
    this._errors = 0
    this._inflight = false
    this._lastBackendFrames = 0
    this._lastReportAt = 0
    this._httpOpts = null
  }

  status() {
    return {
      enabled: this.enabled,
      running: this.running,
      connected: this.running,
      framesSent: this._framesSent,
      framesSkipped: this._framesSkipped,
      errors: this._errors,
      backendObserves: this._lastBackendFrames,
      fps: this.fps
    }
  }

  start() {
    if (this.running) return
    if (!this.enabled) { _vdiag('未启用，不启动'); return }
    try {
      const u = new URL(this.backendUrl)
      this._httpOpts = {
        hostname: u.hostname,
        port: Number(u.port) || 80,
        path: u.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' }
      }
    } catch (e) {
      _vdiag('帧地址不合法，不启动:', String(e).slice(0, 120))
      return
    }
    this.running = true
    _vdiag('连续注视已就绪(HTTP):', this.backendUrl,
           'fps=' + this.fps, 'changeThreshold=' + this.changeThreshold)
    this._scheduleNext(0)
  }

  stop() {
    this.running = false
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this._lastHash = null
    this._lastThumb = null
    _vdiag('已停止；累计送出', this._framesSent, '帧，跳过', this._framesSkipped, '帧')
  }

  _scheduleNext(delayMs) {
    if (!this.running) return
    if (this.timer) clearTimeout(this.timer)
    const interval = Math.max(200, Math.round(1000 / (this.fps || 1)))
    this.timer = setTimeout(() => this._tick(), delayMs !== undefined ? delayMs : interval)
  }

  async _tick() {
    if (!this.running) return
    try {
      await this._captureAndSend()
    } catch (e) {
      this._errors++
      _vdiag('抓帧异常:', String(e && e.message ? e.message : e).slice(0, 150))
    } finally {
      this._scheduleNext()
    }
  }

  async _captureAndSend() {
    if (!this._httpOpts) return

    const disp = screen.getPrimaryDisplay()
    const box = disp.bounds || disp.workArea || { x: 0, y: 0, width: 1920, height: 1080 }

    const tw = Math.max(1, Math.round(box.width))
    const th = Math.max(1, Math.round(box.height))

    try { if (this.protectWindows) this.protectWindows(true) } catch (e) {   }
    let _sources = null
    let _srcErr = null
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: tw, height: th },
        fetchWindowIcons: false
      })
      _sources = sources
    } catch (e) {
      _srcErr = e
    } finally {
      try { if (this.protectWindows) this.protectWindows(false) } catch (e) {   }
    }
    if (_srcErr) throw _srcErr

    const sources = _sources
    if (!sources || !sources.length) {
      _vdiag('desktopCapturer 没有返回屏幕源（权限被拒 / 锁屏 / RDP）')
      this._errors++
      return
    }
    const src = sources[0]
    if (!src.thumbnail || src.thumbnail.isEmpty()) {
      _vdiag('屏幕源缩略图为空')
      this._errors++
      return
    }

    const buf = src.thumbnail.toJPEG(this.quality)
    if (!buf || !buf.length) return

    const hash = crypto.createHash('md5').update(buf).digest('hex')
    if (hash === this._lastHash) {
      this._framesSkipped++
      this._maybeReport()
      return
    }
    this._lastHash = hash

    const thumb = src.thumbnail
    const size = thumb.getSize()
    if (size.width && size.height) {
      const bmp = thumb.toBitmap()
      const prev = this._lastThumb
      if (prev && prev.width === size.width && prev.height === size.height
          && prev.buf.length === bmp.length) {
        let diff = 0
        const step = 4 * 7
        let n = 0
        for (let i = 0; i < bmp.length; i += step) {
          diff += Math.abs(bmp[i] - prev.buf[i])
          n++
        }
        const ratio = n ? (diff / n) / 255 : 1
        if (ratio < this.changeThreshold) {
          this._framesSkipped++
          this._lastThumb = { width: size.width, height: size.height, buf: bmp }
          this._maybeReport()
          return
        }
      }
      this._lastThumb = { width: size.width, height: size.height, buf: bmp }
    }

    this._postFrame(buf)
    this._maybeReport()
  }

  _maybeReport() {
    const now = Date.now()
    if (now - this._lastReportAt < 30000) return
    this._lastReportAt = now
    _vdiag('心跳: 已送', this._framesSent, '帧 / 跳过', this._framesSkipped,
           '帧 / 错误', this._errors,
           '/ 后端实际观察', this._lastBackendFrames, '次')
  }

  _postFrame(buf) {
    if (this._inflight) { this._framesSkipped++; return }
    this._inflight = true

    const opts = Object.assign({}, this._httpOpts, {
      headers: Object.assign({}, this._httpOpts.headers, { 'Content-Length': buf.length })
    })
    let done = false
    const finish = () => { if (!done) { done = true; this._inflight = false } }

    const req = http.request(opts, (res) => {
      let body = ''
      res.on('data', (d) => { body += d.toString() })
      res.on('end', () => {
        finish()
        if (res.statusCode !== 200) {
          this._errors++
          _vdiag('后端返回', res.statusCode, String(body).slice(0, 120))
          return
        }
        this._framesSent++
        try {
          const obj = JSON.parse(body)
          if (typeof obj.frames === 'number') this._lastBackendFrames = obj.frames
          if (obj.active === false && this._framesSent === 1) {
            _vdiag('后端视觉未激活:', String(obj.reason || 'no key / disabled'))
          }
        } catch (e) {   }
      })
    })
    req.setTimeout(8000, () => req.destroy(new Error('timeout')))
    req.on('error', (e) => {
      finish()
      this._errors++
      if (this._errors <= 3 || this._errors % 20 === 0) {
        _vdiag('推帧失败:', String(e && e.message ? e.message : e).slice(0, 120))
      }
    })
    req.write(buf)
    req.end()
  }
}

module.exports = { VisionFramePump }
