const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'js', 'chatroom.html'), 'utf8');
let pass = 0, fail = 0;
function ck(name, cond, extra = '') {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (extra ? '  (' + extra + ')' : '')); }
}

const pureMatch = html.match(/\/\/ ==== XLATE_PURE_START ====\s*\n([\s\S]*?)\n\/\/ ==== XLATE_PURE_END ====/);
ck('找到 XLATE_PURE 模块', !!pureMatch);
if (!pureMatch) process.exit(1);
const host = { window: {} };
const P = new Function('window', pureMatch[1] + '\n;return window.__xlatePure;')(host.window);
ck('splitTargets 已导出', typeof P.splitTargets === 'function');
ck('applyOverlay 支持 idx 定位', /typeof o\.idx === 'number'/.test(pureMatch[1]));

console.log('\n[1] splitTargets 按行切分');
{
    const lines = [
        '[14:30:01] user: 你刚才说的那个搜索完成了吗',
        '[14:30:02] neuro: Not yet, I still need to press enter.'
    ];
    const sel = '你刚才说的那个搜索完成了吗 [14:30:02] neuro: Not yet, I still need to press enter.';
    const loc = P.locate(lines, sel);
    ck('定位到跨 2 行', !!loc && loc.startIdx === 0 && loc.endIdx === 1, JSON.stringify(loc));
    const targets = P.splitTargets(lines, loc.startIdx, loc.endIdx, loc.sel);
    ck('切成 2 段（每条对话一段）', targets.length === 2, JSON.stringify(targets));
    ck('第 1 段是中文对话（去前缀）', targets[0] && targets[0].idx === 0 && targets[0].text.indexOf('搜索完成') >= 0 && targets[0].text.indexOf('user:') < 0, JSON.stringify(targets[0]));
    ck('第 2 段是英文对话（去前缀）', targets[1] && targets[1].idx === 1 && targets[1].text.indexOf('press enter') >= 0 && targets[1].text.indexOf('neuro:') < 0, JSON.stringify(targets[1]));
}

console.log('\n[2] 两条译文各自回到自己的行');
{
    const lines = [
        '[14:30:01] user: 你刚才说的那个搜索完成了吗',
        '[14:30:02] neuro: Not yet, I still need to press enter.'
    ];
    const sel = '你刚才说的那个搜索完成了吗 [14:30:02] neuro: Not yet, I still need to press enter.';
    const loc = P.locate(lines, sel);
    const targets = P.splitTargets(lines, loc.startIdx, loc.endIdx, loc.sel);
    const overlays = targets.map((t, i) => ({ src: t.text, dst: i === 0 ? 'Did that search finish?' : '还没有，我还需要按回车。', idx: t.idx }));
    const out = P.applyOverlay(lines, overlays);
    ck('行数不变（仍 2 行）', out.length === 2, JSON.stringify(out));
    ck('第 1 行变成译文且保留 user 前缀', /^\[14:30:01\] user:/.test(out[0]) && /Did that search finish/.test(out[0]), out[0]);
    ck('第 2 行变成译文且保留 neuro 前缀', /^\[14:30:02\] neuro:/.test(out[1]) && /还没有/.test(out[1]), out[1]);
    ck('第 2 行不再是被清空后的残片', out[1].trim().length > 8 && out[1].indexOf('press enter') < 0, out[1]);
    ck('原文数组未被污染', lines[0].indexOf('搜索完成') >= 0 && lines[1].indexOf('press enter') >= 0);
}

console.log('\n[3] 相同文字的两条对话用 idx 精确定位');
{
    const lines = ['[10:00:01] user: hello', '[10:00:02] user: hello', '[10:00:03] neuro: bye'];
    const out = P.applyOverlay(lines, [{ src: 'hello', dst: '你好', idx: 0 }, { src: 'hello', dst: '嗨', idx: 1 }]);
    ck('第 1 条 hello → 你好', /你好/.test(out[0]), out[0]);
    ck('第 2 条 hello → 嗨（没有错位都变你好）', /嗨/.test(out[1]), out[1]);
}

console.log('\n[4] E2E：点一次「译」发出 2 个请求、两条对话各自翻译');
function makeEl() {
    const el = {
        textContent: '', _html: '', className: '', value: '', disabled: false,
        style: {}, scrollTop: 0, scrollHeight: 100, clientHeight: 100,
        childNodes: [], _first: null, parentNode: null,
        addEventListener() {}, appendChild(n) { this.childNodes.push(n); return n; },
        removeChild() {}, replaceChild(n) { return n; },
        insertAdjacentHTML() {}, querySelectorAll() { return []; }, focus() {},
        getBoundingClientRect() { return { height: 200, top: 0, left: 0, right: 100, bottom: 34 }; },
        getContext() { return null; }
    };
    Object.defineProperty(el, 'firstChild', { get() { return this._first; } });
    Object.defineProperty(el, 'innerHTML', {
        get() { return this._html; },
        set(v) { this._html = String(v); this._first = { textContent: String(v).replace(/<[^>]*>/g, ''), className: '' }; }
    });
    return el;
}
(async function () {
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
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
        globalThis.__neuroTerm = null; globalThis.__neuroTts = null;
    `, ctx);
    let loaded = true;
    try { blocks.forEach(code => vm.runInContext(code, ctx)); } catch (e) { loaded = false; console.log('  [load error] ' + e.message); }
    ck('页面脚本在沙箱执行成功', loaded);
    if (!loaded) return finish();
    ctx.__bindControls();

    const raw = [
        '[14:30:01] user: 你刚才说的那个搜索完成了吗',
        '[14:30:02] neuro: Not yet, I still need to press enter.'
    ];
    const sel = '你刚才说的那个搜索完成了吗 [14:30:02] neuro: Not yet, I still need to press enter.';
    ctx.__rawChat = raw.slice();
    ctx.__lastChat = raw.slice();
    ctx.__sel = { isCollapsed: false, toString() { return sel; }, removeAllRanges() {} };
    const sent = [];
    ctx.fetch = function (url, opts) {
        const text = JSON.parse(opts.body).text;
        sent.push(text);
        const dst = text.indexOf('搜索') >= 0 ? 'Did that search finish?' : '还没有，我还需要按回车。';
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, text: dst }) });
    };
    els['xlate'].onclick();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    ck('发出了 2 个独立翻译请求', sent.length === 2, JSON.stringify(sent));
    const shown = ctx.__lastChat.join('\n');
    ck('两条对话都出现译文', /Did that search finish/.test(shown) && /还没有/.test(shown), shown);
    ck('两条对话都保留各自前缀', /\[14:30:01\] user:/.test(shown) && /\[14:30:02\] neuro:/.test(shown), shown);
    ck('overlay 记录了 2 条（各带 idx）', ctx.__xlateOverlay.length === 2 && ctx.__xlateOverlay.every(o => typeof o.idx === 'number'), JSON.stringify(ctx.__xlateOverlay));
    finish();
})().catch(e => { console.log('  [e2e error] ' + (e && e.stack || e)); fail++; finish(); });

function finish() {
    console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
    process.exitCode = fail ? 1 : 0;
}
