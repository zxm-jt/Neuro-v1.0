// 字幕顺序：她的台词绝不能落到「我最新一句话之前」的行上。
// 背景：segToken 推进规则是"下一条未播 neuro 行"，不看轮次边界。上一轮若有没播到的
// 台词（打断/跳过），用户下一句一开口，新一轮语音就会把文字灌进【上一轮那行空占位】，
// 而那一行在我说的话上面 —— 表现就是"她的话出现在我说的话前面"。
// 运行：node tests/check_subtitle_order.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'js', 'chatroom.html'), 'utf8');
const SCRIPTS = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
const code = [...html.matchAll(SCRIPTS)].map(m => m[1]).join('\n');

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 FAIL: ' + name + (extra ? '  (' + extra + ')' : '')); }
};

// ---------- 最小 DOM 沙箱（与 check_subtitle_stream 同一套做法） ----------
function makeEl() {
  const el = {
    textContent: '', className: '', value: '', disabled: false, _html: '',
    style: {}, scrollTop: 0, scrollHeight: 100, clientHeight: 100,
    children: [], _typingTick: false,
    addEventListener() {}, removeEventListener() {},
    appendChild(n) { this.children.push(n); if (n) n.parentNode = this; return n; },
    replaceChild(n, o) { const i = this.children.indexOf(o); if (i < 0) this.children.push(n); else this.children[i] = n; if (n) n.parentNode = this; return o; },
    removeChild(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); return o; },
    insertAdjacentHTML() {}, querySelectorAll() { return []; }, focus() {},
    getContext() {
      return new Proxy({}, { get(t, k) {
        if (k === 'getShaderParameter' || k === 'getProgramParameter') return () => true;
        if (k === 'createShader' || k === 'createProgram' || k === 'createBuffer') return () => ({});
        if (k === 'getAttribLocation' || k === 'getUniformLocation') return () => 0;
        if (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k)) return 1;
        return () => {};
      } });
    },
    getBoundingClientRect() { return { height: 200, top: 0 }; },
    parentElement: { getBoundingClientRect() { return { height: 400 }; } }
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) {
      el._html = String(v || '');
      const m = /^<div class="([^"]*)">([\s\S]*)<\/div>$/.exec(el._html);
      if (m) {
        el.className = m[1];
        const sm = /<span class="typing"[^>]*>([\s\S]*?)<\/span>/.exec(m[2]);
        const raw = sm ? sm[1] : m[2].replace(/<[^>]*>/g, '');
        el.textContent = raw.replace(/&nbsp;/g, '\u00a0').replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      }
      el.firstChild = el;
    }
  });
  return el;
}

function load(src) {
  const els = {};
  const sandbox = {
    document: {
      getElementById(id) { if (!els[id]) els[id] = makeEl(); return els[id]; },
      createElement() { return makeEl(); }, body: makeEl(),
      addEventListener() {}, removeEventListener() {}
    },
    getSelection() { return { isCollapsed: true, toString() { return ''; }, removeAllRanges() {}, addRange() {} }; },
    setInterval() { return 0; }, clearInterval() {}, setTimeout() { return 0; }, clearTimeout() {},
    requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    confirm() { return true; }, alert() {}, prompt() { return ''; },
    addEventListener() {}, removeEventListener() {},
    location: { href: '', search: '', hash: '' },
    fetch() { return Promise.reject(new Error('offline')); },
    console: { log() {}, warn() {}, error() {} },
    Date, Math, Number, String, Object, Array, RegExp, JSON,
    parseInt, parseFloat, isFinite, Boolean, Error, Promise
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext('globalThis.window = globalThis;', ctx);
  vm.runInContext(src, ctx);

  const reset = (idx, words) => {
    ctx.__lastContentSig = {}; ctx.__sig = {};
    ctx.__lastProgressTs = 0; ctx.__ttsLastAt = 0; ctx.__ttsEverPlaying = true;
    ctx.__lastSegToken = 1; ctx.__ttsInterruptLock = false; ctx.__ttsInterruptLockAt = 0;
    ctx.__holdSince = 0; ctx.__holdCursorAt = 0; ctx.__holdCursorIdx = -1;
    ctx.__lastEffectiveProgressAt = 0;
    ctx.__typer = { idx, words: words.slice(), shown: words.length, frozen: false,
                    lineSig: '', mode: 'tts' };
  };
  const step = (p, lines) => {
    ctx.__applyTtsProgress(p, lines);
    ctx.paint(sandbox.document.getElementById('chat'), lines, 'chat');
    return { idx: ctx.__typer.idx, shown: ctx.__typer.shown,
             frozen: ctx.__typer.frozen, mode: ctx.__typer.mode };
  };
  return { ctx, reset, step, chat: () => els['chat'] || sandbox.document.getElementById('chat') };
}

// 场景：上一轮第二句（idx 2）被打断没播到，我随即开口（idx 3），
// 她的新一轮回复落在 idx 4。新一段语音【必须】落到 4，不能灌回 2。
const LINES = [
  '[10:00:00] user: first question',                                    // 0
  '[10:00:01] neuro: alpha one is a fairly long first sentence here',   // 1 已播
  '[10:00:02] neuro: alpha two never got played because interrupted',   // 2 上一轮遗留
  '[10:00:05] user: second question',                                   // 3 我新说的话
  '[10:00:06] neuro: beta one is the reply to the second question',     // 4 本轮台词
];

console.log('\n[0] 页面脚本加载');
const H = load(code);
ck('页面脚本可加载（paint / __applyTtsProgress / __lineMode 都在）',
   typeof H.ctx.paint === 'function' && typeof H.ctx.__applyTtsProgress === 'function'
   && typeof H.ctx.__lineMode === 'function');

console.log('\n[1] 上一轮遗留行不许被新一段语音"征用"');
H.reset(1, ['alpha', 'one', 'is', 'a']);
let s = H.step({ segToken: 2, frac: 0.5, playing: true, speaking: true, ts: Date.now() }, LINES);
ck('新段推进到本轮台词 idx=4', s.idx === 4, 'idx=' + s.idx);
ck('没有灌回上一轮空行（idx≠2）', s.idx !== 2, 'idx=' + s.idx);

console.log('\n[2] 上一轮遗留行的可见形态');
ck('上一轮遗留行 = 整行（不留空占位）',
   H.ctx.__lineMode(LINES[2], 2, true, 3) === 'full',
   H.ctx.__lineMode(LINES[2], 2, true, 3));
ck('本轮台词 = typing',
   H.ctx.__lineMode(LINES[4], 4, true, 3) === 'typing',
   H.ctx.__lineMode(LINES[4], 4, true, 3));
ck('我已说的话 = 整行（user 行不参与逐词）',
   H.ctx.__lineMode(LINES[3], 3, true, 3) === 'full');

console.log('\n[3] DOM 实际形态（顺序不能颠倒）');
const nodes = H.chat().children;
ck('渲染出 5 行', nodes.length === 5, '实际 ' + nodes.length);
if (nodes.length === 5) {
  const staleNode = nodes[2];
  ck('上一轮遗留行不在 hold（class 不含 hold）',
     String(staleNode.className).indexOf('hold') < 0, 'class=' + staleNode.className);
  ck('本轮台词行是 typing 载体（含 typing span）',
     String(nodes[4]._html).indexOf('typing') >= 0, 'html=' + String(nodes[4]._html).slice(0, 60));
  ck('她说的话都在我这句话之下（不存在越位行）',
     nodes.slice(0, 3).every(n => String(n.className).indexOf('hold') < 0));
}

console.log('\n[4] 同段后续帧 / 下一段 / 无 user 行');
H.reset(4, ['beta', 'one', 'is', 'the']);
H.step({ segToken: 2, frac: 0.6, playing: true, speaking: true, ts: Date.now() }, LINES);
ck('同段后续帧游标不动', H.ctx.__typer.idx === 4, 'idx=' + H.ctx.__typer.idx);
ck('同段后续帧字数前进', H.ctx.__typer.shown > 4, 'shown=' + H.ctx.__typer.shown);

const SOLO = [
  '[10:01:00] neuro: solo one she said on her own',
  '[10:01:05] neuro: solo two she kept going',
];
H.reset(0, ['solo', 'one']);
H.ctx.__lastSegToken = 7;
s = H.step({ segToken: 8, frac: 0.4, playing: true, speaking: true, ts: Date.now() }, SOLO);
ck('她自己开口（无 user 行）时照常推进 idx=1', s.idx === 1, 'idx=' + s.idx);

H.reset(3, ['x']);
H.ctx.__lastSegToken = 1;
s = H.step({ segToken: 2, frac: 0.5, playing: true, speaking: true, ts: Date.now() }, LINES);
ck('游标停在 user 行上时，推进到其后第一条台词', s.idx === 4, 'idx=' + s.idx);

console.log(`\n==== PASS ${pass} / FAIL ${fail} ====`);
process.exit(fail ? 1 : 0);
