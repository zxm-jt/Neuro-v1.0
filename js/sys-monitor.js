const os = require('os')
const { exec } = require('child_process')

let _lastCpu = null

let _slowCache = null
let _slowCacheTime = 0
const SLOW_INTERVAL = 10000


const _cpuHistory = []
const _memHistory = []
const _netHistory = []
const HISTORY_LEN = 60

function _execPowershell(script, timeout = 4000) {
    return new Promise((resolve) => {
        exec(script, {
            windowsHide: true,
            timeout,
            maxBuffer: 1024 * 1024,
            encoding: 'utf8'
        }, (err, stdout) => {
            if (err) return resolve('')
            resolve(stdout || '')
        })
    })
}

function _ps(user, timeout = 4000) {
    return _execPowershell(`powershell.exe -NoProfile -Command "${user}"`, timeout)
}

function _sampleCpu() {
    const cpus = os.cpus()
    let idle = 0, total = 0
    const perCore = []
    for (const c of cpus) {
        const ti = c.times
        const cIdle = ti.idle + (ti.irq || 0)
        const cTotal = ti.user + ti.nice + ti.sys + ti.idle + (ti.irq || 0)
        idle += cIdle
        total += cTotal
        perCore.push({ idle: cIdle, total: cTotal })
    }
    return { idle, total, perCore }
}

function getCpu() {
    const now = _sampleCpu()
    if (!_lastCpu) {
        _lastCpu = now
        return { usage: 0, perCore: now.perCore.map(() => 0), model: os.cpus()[0]?.model || '', cores: os.cpus().length }
    }
    const dIdle = now.idle - _lastCpu.idle
    const dTotal = now.total - _lastCpu.total
    _lastCpu = now
    const usage = dTotal > 0 ? Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100))) : 0
    const perCore = now.perCore.map((c, i) => {
        const p = _lastCpu ? _lastCpu.perCore[i] : null
        if (!p) return 0
        const di = c.idle - p.idle
        const dt = c.total - p.total
        return dt > 0 ? Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100))) : 0
    })
    return { usage, perCore, model: os.cpus()[0]?.model || '', cores: os.cpus().length }
}

function getMem() {
    const total = os.totalmem()
    const free = os.freemem()
    const used = total - free
    return {
        total,
        used,
        free,
        percent: Math.round((used / total) * 100)
    }
}

let _netCounters = null
let _netRate = { rx: 0, tx: 0 }

async function _readNetCounters() {
    const user =
        "$a = Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes,SentBytes -Sum; " +
        "if ($a.Count -ge 2) { '{0},{1}' -f [int64]$a[0].Sum, [int64]$a[1].Sum } else { '0,0' }"
    for (let attempt = 0; attempt < 2; attempt++) {
        const out = await _ps(user, 6000)
        const m = /(\d+)\s*,\s*(\d+)/.exec(String(out || ''))
        if (m) return { rx: Number(m[1]), tx: Number(m[2]), at: Date.now() }
        if (attempt === 0) await new Promise((r) => setTimeout(r, 300))
    }
    return null
}

function getNet() {
    return { rx: _netRate.rx, tx: _netRate.tx }
}

async function _refreshNetRate() {
    const cur = await _readNetCounters()
    if (!cur) return
    if (_netCounters) {
        const dt = (cur.at - _netCounters.at) / 1000
        if (dt > 0) {
            const dRx = cur.rx - _netCounters.rx
            const dTx = cur.tx - _netCounters.tx
            _netRate = {
                rx: dRx >= 0 ? dRx / dt : 0,
                tx: dTx >= 0 ? dTx / dt : 0,
            }
        }
    }
    _netCounters = cur
}

async function getSlow() {
    const now = Date.now()
    if (_slowCache && now - _slowCacheTime < SLOW_INTERVAL) return _slowCache
    const [disk, gpu, temp, procs] = await Promise.all([
        _getDisk(),
        _getGpu(),
        _getTemp(),
        _getTopProcesses()
    ])
    try { await _refreshNetRate() } catch (e) {   }
    _slowCache = { disk, gpu, temp, procs }
    _slowCacheTime = now
    return _slowCache
}

async function _getDisk() {
    const out = await _ps(
        "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | " +
        "Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress"
    )
    if (!out) return []
    try {
        let arr = JSON.parse(out.trim())
        if (!Array.isArray(arr)) arr = [arr]
        return arr.filter(d => d.Size).map(d => ({
            drive: d.DeviceID,
            total: Number(d.Size),
            free: Number(d.FreeSpace),
            used: Number(d.Size) - Number(d.FreeSpace),
            percent: d.Size ? Math.round(((Number(d.Size) - Number(d.FreeSpace)) / Number(d.Size)) * 100) : 0
        }))
    } catch (e) {
        return []
    }
}

async function _getGpu() {
    
    const nv = await _execPowershell(
        'nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits', 3000)
    if (nv && nv.trim()) {
        const parts = nv.trim().split(',').map(s => s.trim())
        if (parts.length >= 3) {
            return {
                name: parts[0],
                util: parseInt(parts[1]) || 0,
                memUsed: parts[2] ? parseInt(parts[2]) : null,
                memTotal: parts[3] ? parseInt(parts[3]) : null,
                temp: parts[4] ? parseInt(parts[4]) : null
            }
        }
    }
    const wm = await _ps("(Get-CimInstance Win32_VideoController | Select-Object -First 1 Name).Name")
    if (wm && wm.trim()) {
        return { name: wm.trim(), util: null, memUsed: null, memTotal: null, temp: null }
    }
    return { name: '未知 GPU', util: null, memUsed: null, memTotal: null, temp: null }
}

async function _getTemp() {
    
    const out = await _ps(
        "(Get-CimInstance MSAcpi_ThermalZoneTemperature -Namespace root/wmi -ErrorAction SilentlyContinue | " +
        "Select-Object -First 1 CurrentTemperature).CurrentTemperature", 3000)
    const v = parseInt(out)
    if (v && v > 0) {
        return Math.round((v / 10) - 273.15)
    }
    return null
}

async function _getTopProcesses() {
    const out = await _ps(
        "$ps = Get-Process; " +
        "[PSCustomObject]@{ total = $ps.Count; top = ($ps | Sort-Object WorkingSet64 -Descending | " +
        "Select-Object -First 12 ProcessName,Id,@{N='Mem';E={[math]::Round($_.WorkingSet64/1MB)}}) } " +
        "| ConvertTo-Json -Depth 3 -Compress"
    )
    if (!out) return { total: 0, top: [] }
    try {
        const obj = JSON.parse(out.trim())
        const total = obj.total || 0
        let top = obj.top || []
        if (!Array.isArray(top)) top = [top]
        return { total, top: top.map(p => ({ name: p.ProcessName, pid: p.Id, mem: p.Mem })) }
    } catch (e) {
        return { total: 0, top: [] }
    }
}

async function snapshot() {
    const cpu = getCpu()
    const mem = getMem()
    const net = getNet()
    const slow = await getSlow()

    _cpuHistory.push(cpu.usage)
    _memHistory.push(mem.percent)
    _netHistory.push(Math.round(net.rx / 1024) + Math.round(net.tx / 1024))
    if (_cpuHistory.length > HISTORY_LEN) _cpuHistory.shift()
    if (_memHistory.length > HISTORY_LEN) _memHistory.shift()
    if (_netHistory.length > HISTORY_LEN) _netHistory.shift()

    return {
        cpu,
        mem,
        net,
        disk: slow.disk,
        gpu: slow.gpu,
        temp: slow.temp,
        procs: slow.procs,
        uptime: Math.round(os.uptime()),
        loadavg: os.loadavg ? os.loadavg() : null,
        history: {
            cpu: _cpuHistory,
            mem: _memHistory,
            net: _netHistory
        }
    }
}

module.exports = { snapshot, getCpu, getMem, getNet, getSlow, _readNetCounters, _refreshNetRate }
