'use strict';

const DESKTOP_OPS = [
    'mouse_move',
    'mouse_click',
    'mouse_double_click',
    'mouse_scroll',
    'key_press',
    'type_text',
    'get_cursor_pos',
];

const LAUNCH_APP_MAP = {
    workbuddy: 'C:\\Users\\<YOUR_USER>\\AppData\\Local\\Programs\\WorkBuddy\\WorkBuddy.exe',
    '微信': 'C:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe',
    wechat: 'C:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe',
    edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '浏览器': 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    explorer: 'C:\\Windows\\explorer.exe',
    '资源管理器': 'C:\\Windows\\explorer.exe',
    'deepseek harness': 'C:\\Users\\<YOUR_USER>\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe',
    deepseek: 'C:\\Users\\<YOUR_USER>\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe',
    harness: 'C:\\Users\\<YOUR_USER>\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe',
};
const KNOWN_LAUNCH_NAMES = Object.keys(LAUNCH_APP_MAP);

const MAX_TYPE_TEXT_LEN = 500;   

const ROOM_OPS = [
    'cpp_set_code',
    'cpp_get_code',
    'cpp_visual_inspect',
    'cpp_run',
    'cpp_debug',
];
const MAX_CPP_CODE_LEN = 20000;  

const MAX_SCROLL_STEPS = 120;    
const MAX_COORD = 32767;         
const MAX_KEYS_LEN = 64;         

const DESKTOP_CONFIRM_COMBOS = [
    'alt+f4',
    'delete+shift',
];

const DESKTOP_REJECT_COMBOS = [
    'alt+ctrl+del',
    'alt+ctrl+delete',
];

const KEY_ALIASES = {
    enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}',
    space: ' ', backspace: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}',
    insert: '{INSERT}', home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
    up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
    f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}',
    f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}',
};

const KEY_MODIFIERS = {
    ctrl: '^', control: '^', alt: '%', shift: '+',
};
const MODIFIER_ORDER = ['shift', 'ctrl', 'alt'];

function escapeSendKeysLiteral(text) {
    const src = String(text == null ? '' : text);
    let out = '';
    for (const ch of src) {
        const code = ch.codePointAt(0);
        if (ch === '\n' || ch === '\r') { out += '{ENTER}'; continue; }
        if (ch === '\t') { out += '{TAB}'; continue; }
        if (code < 0x20 || code === 0x7f) { continue; }
        switch (ch) {
            case '+': out += '{+}'; break;
            case '^': out += '{^}'; break;
            case '%': out += '{%}'; break;
            case '~': out += '{~}'; break;
            case '(': out += '{(}'; break;
            case ')': out += '{)}'; break;
            case '{': out += '{{}'; break;
            case '}': out += '{}}'; break;
            case '[': out += '{[}'; break;
            case ']': out += '{]}'; break;
            default: out += ch;
        }
    }
    return out;
}

function parseKeyCombo(keys) {
    if (typeof keys !== 'string') {
        return { ok: false, error: 'keys 必须是字符串' };
    }
    const raw = keys.trim().toLowerCase();
    if (!raw) return { ok: false, error: 'keys 不能为空' };
    if (raw.length > MAX_KEYS_LEN) {
        return { ok: false, error: 'keys 太长了' };
    }
    const parts = raw.split('+');
    if (parts.some((p) => p === '')) {
        return { ok: false, error: 'keys 写法不对（多写了 +）' };
    }
    const keyToken = parts[parts.length - 1];
    const modTokens = parts.slice(0, -1);

    const mods = [];
    for (const m of modTokens) {
        if (!Object.prototype.hasOwnProperty.call(KEY_MODIFIERS, m)) {
            return { ok: false, error: '不支持的修饰键：' + m + '（只能用 ctrl / alt / shift）' };
        }
        const canon = m === 'control' ? 'ctrl' : m;
        if (!mods.includes(canon)) mods.push(canon);
    }

    let keyOut;
    if (Object.prototype.hasOwnProperty.call(KEY_ALIASES, keyToken)) {
        keyOut = KEY_ALIASES[keyToken];
    } else if (keyToken.length === 1 && /[a-z0-9]/.test(keyToken)) {
        keyOut = keyToken;
    } else {
        return { ok: false, error: '不认识的按键：' + keyToken };
    }

    
    let prefix = '';
    for (const name of MODIFIER_ORDER) {
        if (mods.includes(name)) prefix += KEY_MODIFIERS[name];
    }
    return { ok: true, sendkeys: prefix + keyOut, error: null, combo: raw };
}

function comboKey(tokens) {
    const set = new Set(tokens.map((t) => (t === 'control' ? 'ctrl' : t)));
    return Array.from(set).sort().join('+');
}

function validateDesktopCmd(user) {
    const fail = (error) => ({ ok: false, op: null, args: null, error: error });

    if (!user || typeof user !== 'object') return fail('指令格式不对');
    const op = String(cmd.op || '');
    if (!DESKTOP_OPS.includes(op)) return fail('不认识的桌面操作：' + op);

    const raw = (cmd.args && typeof cmd.args === 'object' && !Array.isArray(cmd.args)) ? cmd.args : {};
    const keys = Object.keys(raw);

    const only = (allowed) => {
        for (const k of keys) {
            if (!allowed.includes(k)) return '参数 ' + k + ' 不适用于 ' + op;
        }
        return null;
    };
    const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
    const coord = (v) => isInt(v) && v >= 0 && v <= MAX_COORD;

    if (op === 'mouse_move') {
        const e = only(['x', 'y']);
        if (e) return fail(e);
        if (!coord(raw.x) || !coord(raw.y)) return fail('mouse_move 需要整数坐标 x 和 y');
        return { ok: true, op: op, args: { x: raw.x, y: raw.y }, error: null };
    }

    if (op === 'mouse_click' || op === 'mouse_double_click') {
        const e = only(['x', 'y', 'button']);
        if (e) return fail(e);
        const args = {};
        const hasX = raw.x !== undefined;
        const hasY = raw.y !== undefined;
        if (hasX !== hasY) return fail(op + ' 的 x 和 y 要么都给，要么都不给');
        if (hasX) {
            if (!coord(raw.x) || !coord(raw.y)) return fail(op + ' 的坐标必须是整数');
            args.x = raw.x; args.y = raw.y;
        }
        let button = 'left';
        if (raw.button !== undefined) {
            if (!['left', 'right', 'middle'].includes(raw.button)) {
                return fail('button 只能是 left / right / middle');
            }
            button = raw.button;
        }
        args.button = button;
        return { ok: true, op: op, args: args, error: null };
    }

    if (op === 'mouse_scroll') {
        const e = only(['amount', 'direction']);
        if (e) return fail(e);
        if (!isInt(raw.amount) || raw.amount < 1 || raw.amount > MAX_SCROLL_STEPS) {
            return fail('mouse_scroll 的 amount 必须是 1~' + MAX_SCROLL_STEPS + ' 的整数');
        }
        let direction = 'down';
        if (raw.direction !== undefined) {
            if (!['up', 'down', 'left', 'right'].includes(raw.direction)) {
                return fail('direction 只能是 up / down / left / right');
            }
            direction = raw.direction;
        }
        return { ok: true, op: op, args: { amount: raw.amount, direction: direction }, error: null };
    }

    if (op === 'key_press') {
        const e = only(['keys']);
        if (e) return fail(e);
        const parsed = parseKeyCombo(raw.keys);
        if (!parsed.ok) return fail(parsed.error);
        const canon = comboKey(parsed.combo.split('+'));
        if (DESKTOP_REJECT_COMBOS.includes(canon)) {
            return fail('组合键 ' + parsed.combo + ' 系统不允许被程序模拟，不做');
        }
        return {
            ok: true, op: op, args: { keys: parsed.combo }, error: null,
            needsConfirm: DESKTOP_CONFIRM_COMBOS.includes(canon),
            sendkeys: parsed.sendkeys,
        };
    }

    if (op === 'type_text') {
        const e = only(['text', 'im']);
        if (e) return fail(e);
        if (typeof raw.text !== 'string') return fail('text 必须是字符串');
        if (raw.text.length > MAX_TYPE_TEXT_LEN) {
            return fail('text 太长了（最多 ' + MAX_TYPE_TEXT_LEN + ' 字）');
        }
        if (raw.im != null && !['zh', 'en', 'shift_en', 'auto'].includes(raw.im)) {
            return fail('im 只能是 zh / en / shift_en / auto');
        }
        return { ok: true, op: op, args: { text: raw.text, im: raw.im || 'auto' }, error: null };
    }

    
    const e = only([]);
    if (e) return fail(e);
    return { ok: true, op: op, args: {}, error: null };
}

const PS_MOUSE_TYPE = 'using System;using System.Runtime.InteropServices;'
    + 'public class NCtl{public struct NPoint{public int X;public int Y;}'
    + '[DllImport("user32.dll")]public static extern bool SetCursorPos(int X,int Y);'
    + '[DllImport("user32.dll")]public static extern bool GetCursorPos(out NPoint p);'
    + '[DllImport("user32.dll")]public static extern void mouse_event(uint dwFlags,uint dx,uint dy,int dwData,UIntPtr dwExtraInfo);}';

const MOUSEEVENTF = {
    LEFTDOWN: 0x0002, LEFTUP: 0x0004,
    RIGHTDOWN: 0x0008, RIGHTUP: 0x0010,
    MIDDLEDOWN: 0x0020, MIDDLEUP: 0x0040,
    WHEEL: 0x0800, HWHEEL: 0x1000,
};
const WHEEL_DELTA = 120;

function base64Utf8(str) {
    return Buffer.from(String(str == null ? '' : str), 'utf8').toString('base64');
}

function psMousePrelude() {
    return "$ErrorActionPreference='Stop';"
        + "Add-Type -TypeDefinition '" + PS_MOUSE_TYPE + "';";
}

function psKeyboardPrelude(sendkeysText) {
    const b64 = base64Utf8(sendkeysText);
    return "$ErrorActionPreference='Stop';"
        + "Add-Type -AssemblyName System.Windows.Forms;"
        + "$k=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "'));"
        + "[System.Windows.Forms.SendKeys]::SendWait($k);"
        + "Write-Output 'SENT';";
}

function psClipboardPaste(text) {
    const b64 = base64Utf8(text);
    return "$ErrorActionPreference='Stop';"
        + "Add-Type -AssemblyName System.Windows.Forms;"
        + "$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "'));"
        + "[System.Windows.Forms.Clipboard]::SetText($t);"
        + "Start-Sleep -Milliseconds 120;"
        + "[System.Windows.Forms.SendKeys]::SendWait('^v');"
        + "Start-Sleep -Milliseconds 80;"
        + "Write-Output 'PASTED';";
}


function textNeedsClipboard(text) {
    return /[\u3400-\u9fff\uF900-\uFAFF]/.test(String(text == null ? '' : text));
}

function resolveTypeMode(text, im) {
    if (im === 'zh') return 'clipboard';
    if (im === 'shift_en') return 'shift_en';
    if (im === 'en') return 'sendkeys';
    return textNeedsClipboard(text) ? 'clipboard' : 'sendkeys';
}

function buildPowerShellCommand(op, args) {
    const bad = (error) => ({ ok: false, command: null, error: error });
    const a = args || {};

    if (op === 'mouse_move') {
        return {
            ok: true,
            command: psMousePrelude()
                + "$tx=" + a.x + ";$ty=" + a.y + ";"
                + "$cx=$tx;$cy=$ty;$p=New-Object NCtl+NPoint;$hit=$false;"
                + "for($i=0;$i -lt 3;$i++){"
                + "[void][NCtl]::SetCursorPos($cx,$cy);"
                + "Start-Sleep -Milliseconds 150;"
                + "[void][NCtl]::GetCursorPos([ref]$p);"
                + "$dx=$tx-$p.X;$dy=$ty-$p.Y;"
                + "if([Math]::Abs($dx) -le 12 -and [Math]::Abs($dy) -le 12){$hit=$true;break}"
                + "$cx=$p.X+$dx;$cy=$p.Y+$dy;"
                + "}"
                + "if($hit){Write-Output ('VERIFY '+$p.X.ToString()+','+$p.Y.ToString())}"
                + "else{Write-Output ('MISS '+$p.X.ToString()+','+$p.Y.ToString())}",
            error: null,
        };
    }

    if (op === 'mouse_click' || op === 'mouse_double_click') {
        const down = { left: MOUSEEVENTF.LEFTDOWN, right: MOUSEEVENTF.RIGHTDOWN, middle: MOUSEEVENTF.MIDDLEDOWN }[a.button || 'left'];
        const up = { left: MOUSEEVENTF.LEFTUP, right: MOUSEEVENTF.RIGHTUP, middle: MOUSEEVENTF.MIDDLEUP }[a.button || 'left'];
        let s = psMousePrelude();
        if (typeof a.x === 'number' && typeof a.y === 'number') {
            
            s += "$tx=" + a.x + ";$ty=" + a.y + ";"
                + "$cx=$tx;$cy=$ty;$p=New-Object NCtl+NPoint;$hit=$false;"
                + "for($i=0;$i -lt 3;$i++){"
                + "[void][NCtl]::SetCursorPos($cx,$cy);"
                + "Start-Sleep -Milliseconds 150;"
                + "[void][NCtl]::GetCursorPos([ref]$p);"
                + "$dx=$tx-$p.X;$dy=$ty-$p.Y;"
                + "if([Math]::Abs($dx) -le 12 -and [Math]::Abs($dy) -le 12){$hit=$true;break}"
                + "$cx=$p.X+$dx;$cy=$p.Y+$dy;"
                + "}"
                + "if($hit){"
                + "[NCtl]::mouse_event(" + down + ",0,0,0,[UIntPtr]::Zero);"
                + "[NCtl]::mouse_event(" + up + ",0,0,0,[UIntPtr]::Zero);";
            if (op === 'mouse_double_click') {
                s += "Start-Sleep -Milliseconds 60;"
                    + "[NCtl]::mouse_event(" + down + ",0,0,0,[UIntPtr]::Zero);"
                    + "[NCtl]::mouse_event(" + up + ",0,0,0,[UIntPtr]::Zero);";
            }
            s += "Write-Output ('VERIFY '+$p.X.ToString()+','+$p.Y.ToString())"
                + "}else{Write-Output ('MISS '+$p.X.ToString()+','+$p.Y.ToString())};";
        } else {
            s += "[NCtl]::mouse_event(" + down + ",0,0,0,[UIntPtr]::Zero);"
                + "[NCtl]::mouse_event(" + up + ",0,0,0,[UIntPtr]::Zero);";
            if (op === 'mouse_double_click') {
                s += "Start-Sleep -Milliseconds 60;"
                    + "[NCtl]::mouse_event(" + down + ",0,0,0,[UIntPtr]::Zero);"
                    + "[NCtl]::mouse_event(" + up + ",0,0,0,[UIntPtr]::Zero);";
            }
            s += "Write-Output 'OK';";
        }
        return { ok: true, command: s, error: null };
    }

    if (op === 'mouse_scroll') {
        const amount = a.amount;
        const dir = a.direction || 'down';
        let flag = MOUSEEVENTF.WHEEL;
        let delta = amount * WHEEL_DELTA;
        if (dir === 'up') delta = amount * WHEEL_DELTA;
        else if (dir === 'down') delta = -amount * WHEEL_DELTA;
        else if (dir === 'left') { flag = MOUSEEVENTF.HWHEEL; delta = -amount * WHEEL_DELTA; }
        else if (dir === 'right') { flag = MOUSEEVENTF.HWHEEL; delta = amount * WHEEL_DELTA; }
        return {
            ok: true,
            command: psMousePrelude()
                + "[NCtl]::mouse_event(" + flag + ",0,0," + delta + ",[UIntPtr]::Zero);"
                + "Write-Output 'OK';",
            error: null,
        };
    }

    if (op === 'key_press') {
        const parsed = parseKeyCombo(a.keys);
        if (!parsed.ok) return bad(parsed.error);
        return { ok: true, command: psKeyboardPrelude(parsed.sendkeys), error: null };
    }

    if (op === 'type_text') {
        const mode = resolveTypeMode(a.text, a.im);
        if (mode === 'clipboard') {
            return { ok: true, command: psClipboardPaste(a.text), error: null };
        }
        return { ok: true, command: psKeyboardPrelude(escapeSendKeysLiteral(a.text)), error: null };
    }

    if (op === 'get_cursor_pos') {
        return {
            ok: true,
            command: psMousePrelude()
                + "$p=New-Object NCtl+NPoint;"
                + "[void][NCtl]::GetCursorPos([ref]$p);"
                + "Write-Output ($p.X.ToString()+','+$p.Y.ToString());",
            error: null,
        };
    }

    return bad('不认识的桌面操作：' + op);
}

class SeenCommandIds {
    constructor(maxSize) {
        this.max = maxSize || 200;
        this.seen = new Set();
        this.order = [];
    }

    
    accept(id) {
        const key = String(id);
        if (!key) return false;
        if (this.seen.has(key)) return false;
        this.seen.add(key);
        this.order.push(key);
        while (this.order.length > this.max) {
            const old = this.order.shift();
            this.seen.delete(old);
        }
        return true;
    }
}

function parseSseLine(line) {
    const t = String(line || '').trim();
    if (!t.startsWith('data:')) return null;
    const body = t.slice(5).trim();
    if (!body || body === '[DONE]') return null;
    let obj;
    try { obj = JSON.parse(body); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object') return null;
    return obj;
}

async function pumpSseForDesktopCmds(response, onCmd, onRoom) {
    try {
        if (!response || !response.body || typeof response.body.getReader !== 'function') return;
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buf = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 1);
                const obj = parseSseLine(line);
                if (obj && obj.desktop_cmd) {
                    try { onCmd(obj.desktop_cmd); } catch (e) {   }
                }
                if (obj && obj.room_cmd && typeof onRoom === 'function') {
                    try { onRoom(obj.room_cmd); } catch (e) {   }
                }
            }
        }
    } catch (e) {
    }
}

function installCommandRouter(opts) {
    const options = opts || {};
    const ipcRenderer = options.ipcRenderer || null;
    const backendUrl = String(options.backendUrl || 'http://127.0.0.1:6006/v2').replace(/\/+$/, '');
    const log = typeof options.log === 'function' ? options.log : function () { };
    const onSpoken = typeof options.onSpoken === 'function' ? options.onSpoken : null;
    
    const visionVerifyUrl = String(options.visionVerifyUrl || '').trim();
    const maxAgeSeconds = options.maxAgeSeconds || 30;
    const seen = new SeenCommandIds(options.maxSeenIds || 200);

    let lastChatBody = null;

    const _opById = new Map();

    async function postResult(id, ok, msg) {
        let messages = [{ role: 'system', content: '' }];
        try {
            if (lastChatBody && Array.isArray(lastChatBody.messages)
                && lastChatBody.messages.length) {
                messages = lastChatBody.messages
                    .filter(function (m) { return m && (m.role === 'system' || m.role === 'user' || m.role === 'assistant'); })
                    .slice(-60)
                    .map(function (m) {
                        return { role: m.role, content: String(m.content || '') };
                    });
            }
        } catch (e) {   }
        const _op = _opById.get(id) || '';
        _opById.delete(id);
        if (_opById.size > 256) {
            const _oldest = _opById.keys().next().value;
            if (_oldest) _opById.delete(_oldest);
        }
        try {
            const resp = await fetch(backendUrl + '/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    stream: true,
                    messages: messages,
                    neuro_memory_mode: 'chat',
                    desktop_cmd_result: {
                        id: id, ok: !!ok, msg: String(msg || ''), op: _op,
                    },
                }),
            });
            
            
            
            if (resp && resp.ok && resp.body && typeof resp.body.getReader === 'function') {
                (async () => {
                    try {
                        const reader = resp.body.getReader();
                        const decoder = new TextDecoder('utf-8');
                        let buf = '';
                        let spoken = '';
                        for (;;) {
                            const { value, done } = await reader.read();
                            if (done) break;
                            buf += decoder.decode(value, { stream: true });
                            let idx;
                            while ((idx = buf.indexOf('\n')) >= 0) {
                                const line = buf.slice(0, idx);
                                buf = buf.slice(idx + 1);
                                const obj = parseSseLine(line);
                                if (obj && obj.desktop_cmd) {
                                    try { handleDesktopCmd(obj.desktop_cmd); } catch (e) {  }
                                }
                                if (obj && obj.choices && obj.choices[0] && obj.choices[0].delta) {
                                    const c = obj.choices[0].delta.content;
                                    if (c) spoken += c;
                                }
                            }
                        }
                        if (spoken && onSpoken) onSpoken(spoken.trim());
                    } catch (e) {   }
                })();
            }
        } catch (e) {
            log('[desktop] 回传执行结果失败: ' + ((e && e.message) || e));
        }
    }

    async function handleDesktopCmd(user) {
        if (!user || typeof user !== 'object') return;

        const id = String(cmd.id || '');
        if (!id) { log('[desktop] 指令没有 id，丢弃'); return; }

        _opById.set(id, String(cmd.op || ''));

        if (!seen.accept(id)) {
            log('[desktop] 重复指令已丢弃: ' + id);
            await postResult(id, false, 'dropped: duplicate command id');
            return;
        }

        
        const ts = Number(cmd.ts || 0);
        if (ts && (Date.now() / 1000 - ts) > maxAgeSeconds) {
            log('[desktop] 过期指令已丢弃: ' + id);
            await postResult(id, false, 'dropped: command expired');
            return;
        }

        const v = validateDesktopCmd(user);
        if (!v.ok) {
            log('[desktop] 指令校验失败: ' + v.error);
            await postResult(id, false, v.error);
            return;
        }

        const _hasXY = (v.op === 'mouse_move' || v.op === 'mouse_click' || v.op === 'mouse_double_click')
            && typeof v.args.x === 'number' && typeof v.args.y === 'number';
        if (_hasXY && (options.visionVerifyUrl || '')) {
            try {
                const r = await fetch(options.visionVerifyUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ x: v.args.x, y: v.args.y }),
                });
                if (r.ok) {
                    const j = await r.json();
                    const txt = String((j && j.text) || '').trim();
                    log('[desktop] 视觉预检 (' + v.op + ' ' + v.args.x + ',' + v.args.y + '): ' + txt.slice(0, 120));
                    v._visionText = txt;
                }
            } catch (e) {
                log('[desktop] 视觉预检失败（不阻断执行）: ' + ((e && e.message) || e));
            }
        }

        if (v.op === 'type_text' && v.args.im === 'shift_en' && (options.visionVerifyUrl || '')) {
            try {
                const r = await fetch(options.visionVerifyUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ime: true }),
                });
                if (r.ok) {
                    const j = await r.json();
                    const txt = String((j && j.text) || '').trim();
                    log('[desktop] IME 视觉校准: ' + txt.slice(0, 120));
                    const looksChinese = /chinese|中文|zh|cn|拼音|pinyin/i.test(txt)
                        || !/english|英文|en|eng|ime\s*:\s*en/i.test(txt);
                    if (looksChinese && ipcRenderer && typeof ipcRenderer.invoke === 'function') {
                        try {
                            await ipcRenderer.invoke('desktop-command', {
                                op: 'key_press', args: { keys: 'shift' }, id: 'ime-switch-' + Date.now(),
                            });
                            log('[desktop] 已按 Shift 切换到英文输入法');
                        } catch (e) {   }
                    }
                }
            } catch (e) {
                log('[desktop] IME 视觉校准失败（不阻断）: ' + ((e && e.message) || e));
            }
        }

        let res = null;
        try {
            if (ipcRenderer && typeof ipcRenderer.invoke === 'function') {
                res = await ipcRenderer.invoke('desktop-command', { op: v.op, args: v.args, id: id });
            } else {
                res = { ok: false, msg: '没有可用的主进程通道' };
            }
        } catch (e) {
            res = { ok: false, msg: '主进程执行异常: ' + ((e && e.message) || e) };
        }

        const ok = !!(res && res.ok);
        const msg = String((res && res.msg) || '');
        log('[desktop] ' + v.op + ' 执行' + (ok ? '成功' : '失败') + ': ' + msg.slice(0, 200));
        await postResult(id, ok, v._visionText ? msg + ' | 视觉预检: ' + v._visionText : msg);
    }

    async function handleRoomCmd(user) {
        if (!user || typeof user !== 'object') return;

        const id = String(cmd.id || '');
        if (!id) { log('[room] 指令没有 id，丢弃'); return; }
        if (!seen.accept(id)) { log('[room] 重复指令已丢弃: ' + id); return; }

        const ts = Number(cmd.ts || 0);
        if (ts && (Date.now() / 1000 - ts) > maxAgeSeconds) {
            log('[room] 过期指令已丢弃: ' + id);
            return;
        }

        const op = String(cmd.op || '');
        if (!ROOM_OPS.includes(op)) {
            log('[room] 不认识的房间操作: ' + op);
            await postResult(id, false, '不认识的房间操作：' + op);
            return;
        }

        const payload = {
            op: op,
            id: id,
            args: (cmd.args && typeof cmd.args === 'object') ? cmd.args : {},
            code: typeof cmd.code === 'string' ? cmd.code : '',
        };
        if (op === 'cpp_set_code' && payload.code.length > MAX_CPP_CODE_LEN) {
            await postResult(id, false, '代码太长了（最多 ' + MAX_CPP_CODE_LEN + ' 字符）');
            return;
        }

        let res = null;
        try {
            if (ipcRenderer && typeof ipcRenderer.invoke === 'function') {
                res = await ipcRenderer.invoke('room-command', payload);
            } else {
                res = { ok: false, msg: '没有可用的主进程通道' };
            }
        } catch (e) {
            res = { ok: false, msg: '主进程执行异常: ' + ((e && e.message) || e) };
        }

        const ok = !!(res && res.ok);
        const msg = String((res && res.msg) || '');
        log('[room] ' + op + ' 执行' + (ok ? '成功' : '失败') + ': ' + msg.slice(0, 200));
        await postResult(id, ok, msg);
    }

    const g = typeof window !== 'undefined' ? window : null;
    let restore = null;
    if (g && typeof g.fetch === 'function') {
        const origFetch = g.fetch.bind(g);
        g.fetch = async function (input, init) {
            const res = await origFetch(input, init);
            try {
                const url = typeof input === 'string' ? input : ((input && input.url) || '');
                const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
                if (ct.indexOf('text/event-stream') >= 0 && url.indexOf('/chat/completions') >= 0) {
                    try {
                        if (init && typeof init.body === 'string') {
                            const b = JSON.parse(init.body);
                            if (b && Array.isArray(b.messages)) lastChatBody = b;
                        }
                    } catch (e) {   }
                    const copy = res.clone();
                    pumpSseForDesktopCmds(copy, handleDesktopCmd, handleRoomCmd);
                }
            } catch (e) {   }
            return res;
        };
        restore = function () { g.fetch = origFetch; };
    }

    return {
        handleDesktopCmd: handleDesktopCmd,
        handleRoomCmd: handleRoomCmd,
        postResult: postResult,
        dispose: function () { if (restore) restore(); },
    };
}

module.exports = {
    DESKTOP_OPS: DESKTOP_OPS,
    ROOM_OPS: ROOM_OPS,
    MAX_CPP_CODE_LEN: MAX_CPP_CODE_LEN,
    DESKTOP_CONFIRM_COMBOS: DESKTOP_CONFIRM_COMBOS,
    DESKTOP_REJECT_COMBOS: DESKTOP_REJECT_COMBOS,
    MAX_TYPE_TEXT_LEN: MAX_TYPE_TEXT_LEN,
    MAX_SCROLL_STEPS: MAX_SCROLL_STEPS,
    MAX_COORD: MAX_COORD,
    KEY_ALIASES: KEY_ALIASES,
    escapeSendKeysLiteral: escapeSendKeysLiteral,
    textNeedsClipboard: textNeedsClipboard,
    resolveTypeMode: resolveTypeMode,
    parseKeyCombo: parseKeyCombo,
    comboKey: comboKey,
    validateDesktopCmd: validateDesktopCmd,
    base64Utf8: base64Utf8,
    buildPowerShellCommand: buildPowerShellCommand,
    SeenCommandIds: SeenCommandIds,
    parseSseLine: parseSseLine,
    pumpSseForDesktopCmds: pumpSseForDesktopCmds,
    installCommandRouter: installCommandRouter,
};
