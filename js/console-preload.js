const { contextBridge, ipcRenderer } = require('electron')

let _dataCb = null
let _exitCb = null

ipcRenderer.on('term:data', (_e, chunk) => {
    if (_dataCb && typeof _dataCb === 'function') {
        try { _dataCb(String(chunk)) } catch (e) {   }
    }
})

ipcRenderer.on('term:exit', (_e, code) => {
    if (_exitCb && typeof _exitCb === 'function') {
        try { _exitCb(code) } catch (e) {   }
    }
})

contextBridge.exposeInMainWorld('__neuroTerm', {
    start: () => ipcRenderer.invoke('term:start'),
    write: (s) => ipcRenderer.invoke('term:write', String(s)),
    kill: () => ipcRenderer.invoke('term:kill'),
    isRunning: () => ipcRenderer.invoke('term:running'),
    onData: (cb) => { _dataCb = cb },
    onExit: (cb) => { _exitCb = cb }
})

contextBridge.exposeInMainWorld('__neuroCpp', {
    probe: () => ipcRenderer.invoke('cpp:probe'),
    compile: (src, mode) => ipcRenderer.invoke('cpp:compile', String(src), mode === 'debug' ? 'debug' : 'run'),
    stdin: (text) => ipcRenderer.invoke('cpp:stdin', String(text))
})
contextBridge.exposeInMainWorld('__neuroFs', {
    list: (dir) => ipcRenderer.invoke('fs:list', dir || ''),
    mkdir: (dir, name) => ipcRenderer.invoke('fs:mkdir', dir || '', String(name)),
    delete: (dir, name) => ipcRenderer.invoke('fs:delete', dir || '', String(name)),
    open: (dir, name) => ipcRenderer.invoke('fs:open', dir || '', String(name)),
    read: (dir, name) => ipcRenderer.invoke('fs:read', dir || '', String(name)),
    root: () => ipcRenderer.invoke('fs:root'),
    drives: () => ipcRenderer.invoke('fs:drives')
})

let _ttsCb = null
ipcRenderer.on('tts:progress', (_e, p) => {
    if (_ttsCb && typeof _ttsCb === 'function') {
        try { _ttsCb(p) } catch (e) {   }
    }
})
contextBridge.exposeInMainWorld('__neuroTts', {
    onProgress: (cb) => { _ttsCb = cb }
})

let _roomCb = null
ipcRenderer.on('room:user', (_e, p) => {
    if (_roomCb && typeof _roomCb === 'function') {
        try { _roomCb(p) } catch (e) {   }
    }
})
contextBridge.exposeInMainWorld('__neuroRoom', {
    onCmd: (cb) => { _roomCb = cb }
})

contextBridge.exposeInMainWorld('__neuroWin', {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    close: () => ipcRenderer.invoke('win:close')
})

contextBridge.exposeInMainWorld('__neuroSys', {
    procs: () => ipcRenderer.invoke('sys:procs'),
    kill: (pid) => ipcRenderer.invoke('sys:kill', pid),
    launch: (target) => ipcRenderer.invoke('sys:launch', String(target)),
    reload: () => ipcRenderer.invoke('sys:reload')
})
