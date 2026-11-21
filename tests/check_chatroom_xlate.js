const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'js', 'chatroom.html'), 'utf8');

let pass = 0, fail = 0;
function ck(name, cond, extra = '') {
    if (cond) { pass++; console.log('  \u2713 ' + name); }
    else { fail++; console.log('  \u2717 FAIL: ' + name + (extra ? '  (' + extra + ')' : '')); }
}

console.log('\n[0] 内嵌 <script> 语法校验');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
ck('至少 2 个 <script> 块', blocks.length >= 2, 'got ' + blocks.length);
blocks.forEach((code, i) => {
    let ok = true, err = '';
    try { new Function(code); } catch (e) { ok = false; err = e.message; }
    ck('第 ' + (i + 1) + ' 个 <script> 语法正确', ok, err);
});
ck('保留 window.__render 定义', /__render\s*=/.test(html));

console.log('\n[1] 载入页面里的 XLATE_PURE 实现（不复制逻辑）');
const pureMatch = html.match(/\/\/ ==== XLATE_PURE_START ====\s*\n([\s\S]*?)\n\/\/ ==== XLATE_PURE_END ====/);
ck('找到 XLATE_PURE 标记区间', !!pureMatch);
if (!pureMatch) { process.exit(1); }
const host = { window: {}, Date, Math, Number, String, Object, Array, RegExp, JSON, console };
let P;
try {
    P = new Function('window', pureMatch[1] + '\n;return window.__xlatePure;')(host.window);
    ck('纯函数模块可执行并暴露 API', !!(P && P.locate && P.applyRange && P.applyOverlay));
} catch (e) {
    ck('纯函数模块可执行并暴露 API', false, e.message);
    process.exit(1);
}

console.log('\n[2] 单行 / 跨 2 行 / 跨多行（每行带 [时间] 说话人: 前缀）');
{
    const lines = ['[12:00:01] user: 你好', '[12:00:02] neuro: Hello world and goodbye moon.'];
    const sel = 'Hello world';
    const loc = P.locate(lines, sel);
    ck('单行定位到正确行', !!loc && loc.startIdx === 1 && loc.endIdx === 1);
    const out = P.applyOverlay(lines, [{ src: sel, dst: '你好世界' }]);
    ck('单行就地替换', out[1].indexOf('你好世界') >= 0 && out[1].indexOf('Hello world') < 0);
    ck('单行不影响其它行', out[0] === lines[0]);
}
{
    const lines = ['[12:00:02] neuro: Hello world and', '[12:00:03] neuro: goodbye moon.'];
    const sel = 'world and [12:00:03] neuro: goodbye';
    const loc = P.locate(lines, sel);
    ck('跨 2 行定位（含中间行前缀的选区）', !!loc && loc.startIdx === 0 && loc.endIdx === 1,
        loc && JSON.stringify(loc));
    const out = P.applyOverlay(lines, [{ src: sel, dst: '世界再见' }]);
    ck('跨 2 行首行保留前缀且写入译文', out[0] === '[12:00:02] neuro: Hello 世界再见', out[0]);
    ck('跨 2 行尾行保留命中之后的文字', out[1].trim() === 'moon.', out[1]);
}
{
    const lines = [
        '[21:22:01] neuro: Alpha bravo',
        '[21:22:02] neuro: Charlie delta',
        '[21:22:03] neuro: Echo foxtrot'
    ];
    const sel = 'bravo [21:22:02] neuro: Charlie delta [21:22:03] neuro: Echo';
    const loc = P.locate(lines, sel);
    ck('跨 3 行定位', !!loc && loc.startIdx === 0 && loc.endIdx === 2, loc && JSON.stringify(loc));
    const out = P.applyOverlay(lines, [{ src: sel, dst: '译文XYZ' }]);
    ck('跨 3 行首行', out[0] === '[21:22:01] neuro: Alpha 译文XYZ', out[0]);
    ck('跨 3 行中间行清空（不增删行）', out.length === 3 && out[1] === '', JSON.stringify(out));
    ck('跨 3 行尾行保留余文', out[2].trim() === 'foxtrot', out[2]);
}
{
    const lines = ['[上次会话] [21:22:01] neuro: Alpha bravo', '[上次会话] [21:22:02] neuro: Charlie delta'];
    const sel = 'bravo [上次会话] [21:22:02] neuro: Charlie';
    const loc = P.locate(lines, sel);
    ck('多层方括号历史行跨行定位', !!loc && loc.startIdx === 0 && loc.endIdx === 1, loc && JSON.stringify(loc));
    const out = P.applyOverlay(lines, [{ src: sel, dst: '历史译文' }]);
    ck('多层方括号历史行替换', out[0].indexOf('历史译文') >= 0 && out.length === 2, JSON.stringify(out));
}

console.log('\n[3] 重复翻译叠加 / 原文恢复 / 翻译失败回落');
{
    const lines = [
        '[10:00:01] neuro: First sentence here.',
        '[10:00:02] user: user line',
        '[10:00:03] neuro: Second sentence there.'
    ];
    const out = P.applyOverlay(lines, [
        { src: 'First sentence', dst: '第一句' },
        { src: 'Second sentence', dst: '第二句' }
    ]);
    ck('两处不同译文正确叠加 ①', out[0].indexOf('第一句') >= 0, out[0]);
    ck('两处不同译文正确叠加 ②', out[2].indexOf('第二句') >= 0, out[2]);
    ck('原文数组未被污染', lines[0].indexOf('First sentence') >= 0 && lines[2].indexOf('Second sentence') >= 0);
    const restored = P.applyOverlay(lines, []);
    ck('「原文」恢复原始内容', restored.join('\n') === lines.join('\n'));
    const miss = P.applyOverlay(lines, [{ src: 'no such words anywhere', dst: 'X' }]);
    ck('overlay 定位失败时字幕原样返回（不白屏）', miss.join('\n') === lines.join('\n'));
}
{
    // 静态兜底：fetch 失败分支不得重绘字幕、必须清 busy
    const catchBlock = (html.match(/\}\)\.catch\(function\(e\)\{([\s\S]*?)\n    \}\);/) || [])[1] || '';
    ck('网络失败分支清 busy 且不 paint', /busy\s*=\s*false/.test(catchBlock) && !/paint\(/.test(catchBlock));
    const failBlock = (html.match(/\n      \} else \{\n        __xlateState\.idx = -1;([\s\S]*?)\n      \}\n    \}\)\.catch/) || [])[1] || '';
    ck('{ok:false} 分支不改字幕', !/paint\(/.test(failBlock));
}

console.log('\n[4] 字幕显示：游标生存期逃生舱已真正可用');
{
    const escape = (html.match(/if \(gating && _hasUnplayed\) \{([\s\S]*?)\n  \} else if \(!gating\)/) || [])[1] || '';
    ck('逃生舱在 __holdCursorAt 未起表时也初始化', /if \(!__holdCursorAt \|\| __typer\.idx !== __holdCursorIdx\)/.test(escape));
    ck('逃生舱以有效进度时间戳为准', /__lastEffectiveProgressAt/.test(escape) && /__HOLD_MAX_MS/.test(escape));
    ck('__applyTtsProgress 三处有效推进均打点', (html.match(/return __progressMoved\(\)/g) || []).length >= 3);
    ck('实时进度定位改用原文（翻译后不卡游标）', /__applyTtsProgress\(p, matchLines\)/.test(html));
    // 注意：注释里引用了旧写法，必须校验【真实代码】而不是注释
    ck('保留历史修复：选区残留不再阻断 paint',
        /var _sel = hasSelection\(\);\s*\n\s*if \(__paused\) return;/.test(html));
}

console.log('\n[5] 端到端：点「译」/「原文」/服务失败（vm 执行真实页面脚本）');
function makeEl() {
    const el = {
        textContent: '', innerHTML: '', className: '', value: '', disabled: false,
        style: {}, scrollTop: 0, scrollHeight: 100, clientHeight: 100,
        childNodes: [], _first: null, parentNode: null,
        addEventListener() {}, appendChild(n) { this.childNodes.push(n); return n; },
        removeChild() {}, replaceChild(n) { return n; },
        insertAdjacentHTML() {}, querySelectorAll() { return []; }, focus() {},
        getBoundingClientRect() { return { height: 200, top: 0, left: 0, right: 100, bottom: 34 }; },
        getContext() { return null; }   // 3D 脑图脚本会安全早退，不影响字幕逻辑
    };
    Object.defineProperty(el, 'firstChild', { get() { return this._first; } });
    Object.defineProperty(el, 'innerHTML', {
        get() { return this._html || ''; },
        set(v) { this._html = v; this._first = { textContent: String(v).replace(/<[^>]*>/g, ''), className: '' }; }
    });
    return el;
}
(async function () {
    const els = {};
    const ctx = vm.createContext({
        document: {
            getElementById(id) { if (!els[id]) els[id] = makeEl(); return els[id]; },
            body: makeEl(), createElement() { return makeEl(); }, createTextNode() { return {}; },
            addEventListener() {}
        },
        getSelection() { return ctx.__sel || { isCollapsed: true, toString() { return ''; }, removeAllRanges() {} }; },
        setInterval() { return 0; }, clearInterval() {}, setTimeout() { return 0; }, clearTimeout() {},
        requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
        confirm() { return true; }, alert() {}, prompt() { return ''; },
        addEventListener() {}, removeEventListener() {},
        location: { origin: 'http://127.0.0.1:6006' },
        console, Date, Math, Number, String, Object, Array, RegExp, JSON, Promise, Float32Array
    });
    vm.runInContext('globalThis.window = globalThis;', ctx);
    vm.runInContext(`
        globalThis.__neuroFs = { list: function(){ return { then: function(){} }; } };
        globalThis.__neuroRoom = { onCmd: function(){} };
        globalThis.__neuroCpp = { probe: function(){ return { then: function(){} }; }, compile: function(){} };
        globalThis.__neuroTerm = null;
        globalThis.__neuroTts = null;
    `, ctx);
    let loaded = true;
    try { blocks.forEach(code => vm.runInContext(code, ctx)); } catch (e) { loaded = false; console.log('  [load error] ' + e.message); }
    ck('整段页面脚本在沙箱执行成功', loaded);
    if (!loaded) { return finish(); }
    ctx.__bindControls();
    ck('__bindControls 成功（译/原文已绑定）', typeof els['xlate'].onclick === 'function' && typeof els['xshow'].onclick === 'function');

    const raw = [
        '[14:30:39] neuro: Subtitles not showing and what is the and.',
        '[14:30:42] user: 不能跨行翻译这两个。',
        '[14:30:43] neuro: Subtitles break when a sentence wraps to a second line.'
    ];
    const sel = 'not showing and what is the and.';
    ctx.__rawChat = raw.slice();
    ctx.__lastChat = raw.slice();
    ctx.__sel = { isCollapsed: false, toString() { return sel; }, removeAllRanges() {} };
    let sentText = null;
    ctx.fetch = function (url, opts) {
        sentText = JSON.parse(opts.body).text;
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, text: '译文OK' }) });
    };
    els['xlate'].onclick();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    ck('「译」把选区原文发给后端', sentText === sel, String(sentText));
    ck('「译」成功后字幕就地出现译文', ctx.__lastChat.join('\n').indexOf('译文OK') >= 0, ctx.__lastChat.join('\n'));

    els['xshow'].onclick();
    ck('「原文」恢复无译文', ctx.__lastChat.join('\n') === raw.join('\n'), ctx.__lastChat.join('\n'));

    ctx.__rawChat = raw.slice();
    ctx.__lastChat = raw.slice();
    ctx.__sel = { isCollapsed: false, toString() { return sel; }, removeAllRanges() {} };
    ctx.fetch = function () { return Promise.reject(new Error('offline')); };
    els['xlate'].onclick();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    ck('服务失败时字幕保持原文', ctx.__lastChat.join('\n') === raw.join('\n'), ctx.__lastChat.join('\n'));
    ck('服务失败后按钮恢复为「译」', els['xlate'].textContent === '译', els['xlate'].textContent);
    ck('服务失败显示失败提示', els['xlateresult'].innerHTML.indexOf('失败') >= 0, els['xlateresult'].innerHTML);

    finish();
})().catch(e => { console.log('  [e2e error] ' + (e && e.stack || e)); fail++; finish(); });

function finish() {
    console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
    process.exitCode = fail ? 1 : 0;
}
