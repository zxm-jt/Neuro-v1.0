const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')

const DEBUG_PORTS = [9222, 9223, 9224, 9225]


const BROWSERS = [
    {
        name: 'Edge',
        process: 'msedge.exe',
        dataDirs: [
            path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data')
        ]
    },
    {
        name: 'Chrome',
        process: 'chrome.exe',
        dataDirs: [
            path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
        ]
    }
]

function _httpJson(url, timeout = 2000) {
    return new Promise((resolve) => {
        const req = http.get(url, { timeout }, (res) => {
            let data = ''
            res.on('data', (c) => data += c)
            res.on('end', () => {
                try { resolve(JSON.parse(data)) } catch (e) { resolve(null) }
            })
        })
        req.on('error', () => resolve(null))
        req.on('timeout', () => { req.destroy(); resolve(null) })
    })
}

async function _detectDebugPort() {
    for (const port of DEBUG_PORTS) {
        const list = await _httpJson(`http://127.0.0.1:${port}/json`)
        if (list && Array.isArray(list)) {
            
            const tabs = list
                .filter(t => t.type === 'page')
                .map(t => ({
                    title: t.title || '(无标题)',
                    url: t.url || '',
                    active: false
                }))
            if (tabs.length) return { browser: 'Chromium (调试端口 ' + port + ')', tabs }
        }
    }
    return null
}

function _readSessionTabs() {
    for (const b of BROWSERS) {
        for (const dd of b.dataDirs) {
            for (const profile of ['Default', 'Profile 1']) {
                const cur = path.join(dd, profile, 'Current Tabs')
                if (!fs.existsSync(cur)) continue
                try {
                    const buf = fs.readFileSync(cur)
                    const text = buf.toString('utf16le')
                    const titles = []
                    const re = /[\u4e00-\u9fa5A-Za-z0-9][^\u0000]{2,80}/g
                    let m, count = 0
                    while ((m = re.exec(text)) && count < 20) {
                        const t = m[0].trim()
                        if (t && t.length > 1 && !/^[\u0000-\u001f]+$/.test(t)) {
                            titles.push({ title: t, url: '', active: false })
                            count++
                        }
                    }
                    if (titles.length) return { browser: b.name + ' (会话快照)', tabs: titles }
                } catch (e) {   }
            }
        }
    }
    return null
}


function _browserRunning() {
    const { exec } = require('child_process')
    return new Promise((resolve) => {
        exec(
            'powershell.exe -NoProfile -Command "Get-Process msedge,chrome -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName -Unique"',
            { windowsHide: true, encoding: 'utf8', timeout: 3000 },
            (err, stdout) => {
                if (err) return resolve([])
                const names = (stdout || '').trim().split(/\s+/).filter(Boolean)
                resolve(names)
            }
        )
    })
}


async function detectTabs() {
    const viaPort = await _detectDebugPort()
    if (viaPort) {
        return { detected: true, ...viaPort, hint: '' }
    }
    const viaSession = _readSessionTabs()
    if (viaSession) {
        return { detected: true, ...viaSession, hint: '(标题来自会话快照，未开调试端口，无法获取 URL)' }
    }
    const running = await _browserRunning()
    return {
        detected: false,
        browser: '',
        tabs: [],
        hint: running.length
            ? '检测到 ' + running.join('/') + ' 在运行，但未开调试端口。' +
              '用「--remote-debugging-port=9222」启动浏览器即可实时读取标签页。'
            : '未检测到浏览器进程。'
    }
}

module.exports = { detectTabs, DEBUG_PORTS }
