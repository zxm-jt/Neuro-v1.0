const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'js', 'chatroom.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8');
const SCRIPTS = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
const code = [...html.matchAll(SCRIPTS)].map(m => m[1]).join('\n');

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 FAIL: ' + name + (extra ? '  (' + extra + ')' : '')); }
};

// ---------- 最小 DOM 沙箱 ----------
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
    console, Date, Math, Number, String, Object, Array, RegExp, JSON,
    parseInt, parseFloat, isFinite, Boolean, Error, Promise
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext('globalThis.window = globalThis;', ctx);
  let err = null;
  try { vm.runInContext(src, ctx); } catch (e) { err = e; }
  function reset() {
    ctx.__lastContentSig = {}; ctx.__sig = {}; ctx.__lastProgressTs = 0;
    ctx.__ttsEverPlaying = false; ctx.__ttsLastAt = 0; ctx.__ttsLastSeg = '';
    ctx.__lastSegToken = 0; ctx.__ttsInterruptLock = false; ctx.__ttsInterruptLockAt = 0;
    ctx.__holdSince = 0; ctx.__holdCursorAt = 0; ctx.__holdCursorIdx = -1;
    ctx.__lastEffectiveProgressAt = 0;
    ctx.__typer = { idx: -1, words: [], shown: 0, frozen: true, lineSig: '', mode: 'fixed' };
    ctx.window.__rawChat = null; ctx.window.__lastChat = null;
  }
  function step(p, lines) {
    const changed = ctx.__applyTtsProgress(p, lines);
    ctx.paint(sandbox.document.getElementById('chat'), lines, 'chat');
    return {
      changed, idx: ctx.__typer.idx, shown: ctx.__typer.shown,
      frozen: ctx.__typer.frozen, mode: ctx.__typer.mode,
      text: String(ctx.__typingText()).trim()
    };
  }
  return { ctx, sandbox, els, err, reset, step };
}

let TS = Date.now();
const tick = () => TS++;
const H = load(code);
const LINES = [
  '[13:00:01] user: user question',
  '[13:00:02] neuro: Alpha beta gamma delta epsilon.',
  '[13:00:03] neuro: Second line zeta eta theta iota.',
  '[13:00:04] neuro: Third line kappa lambda mu nu.'
];

console.log('\n[0] 页面脚本加载 + 源码契约');
ck('chatroom.html <script> 完整执行无异常', H.err === null, H.err && H.err.message);
ck('关键纯函数存在', ['__applyTtsProgress', '__shownByCharFrac', '__lineMode', '__typingText', '__xlatePure']
  .every(n => typeof H.ctx[n] !== 'undefined'));
ck('app.js 上报 segToken（粉色字幕同源）', /t\._segToken/.test(appJs)
  && /interrupting, segToken, live, ts/.test(appJs));
ck('app.js 节流把 segToken 纳入比较（新段不被吞）', /segToken === _lastTtsProg\.segToken/.test(appJs));
ck('main.js 整体透传进度对象', /webContents\.send\('tts:progress', p\)/.test(mainJs));
ck('无 segToken 时回落文本匹配（向后兼容）', /无 segToken 时沿用旧的 seg 文本模糊匹配/.test(html));
ck('保留断桥兜底（看门狗 + 游标逃生舱）', /__holdWatchdog\(/.test(html) && /__lastEffectiveProgressAt/.test(html));
ck('保留圈选翻译能力', /__xlatePure/.test(html) && /applyOverlay/.test(html));
ck('frac 来自逐字揭示比例', /revealed \/ total/.test(appJs) && /__shownByCharFrac\(words, target\.body, frac\)/.test(html));
ck('同字行 shown 单调保护', /shown < __typer\.shown\) shown = __typer\.shown/.test(html));

console.log('\n[1] segToken 驱动：seg 文本完全不匹配时游标仍逐段推进（核心）');
H.reset();
const a1 = H.step({ seg: '@@@无关@@@', segToken: 1, frac: 0, playing: false, speaking: true, ts: tick() }, LINES);
const a2 = H.step({ seg: '@@@无关@@@', segToken: 1, frac: 0.3, playing: true, speaking: true, ts: tick() }, LINES);
const a3 = H.step({ seg: '@@@无关@@@', segToken: 1, frac: 0.8, playing: true, speaking: true, ts: tick() }, LINES);
const beforeAdvance = H.ctx.__typer.shown;
const a4 = H.step({ seg: '@@@无关@@@', segToken: 2, frac: 0, playing: true, speaking: true, ts: tick() }, LINES);
const a5 = H.step({ seg: '@@@无关@@@', segToken: 2, frac: 0.6, playing: true, speaking: true, ts: tick() }, LINES);
const a6 = H.step({ seg: '@@@无关@@@', segToken: 3, frac: 0.4, playing: true, speaking: true, ts: tick() }, LINES);
ck('第 1 帧定位到首条 neuro 行', a1.idx === 1, 'idx=' + a1.idx);
ck('同一行内 shown 由 frac 单调揭示', a2.shown > 0 && a3.shown > a2.shown,
  '[' + a2.shown + ',' + a3.shown + ']');
ck('未播完（验证前提成立）', beforeAdvance < H.ctx.__typer.words.length + 5);
ck('segToken 变化 → 游标推进到第 2 行', a4.idx === 2, 'idx=' + a4.idx);
ck('新段先把上一行补齐整行（无半句残留）',
  H.ctx.__lineMode(LINES[1], 1, true) === 'full', H.ctx.__lineMode(LINES[1], 1, true));
ck('新行从 0 词开始揭示', a4.shown === 0, 'shown=' + a4.shown);
ck('第 2 行继续单调推进', a5.shown > a4.shown, '[' + a4.shown + ',' + a5.shown + ']');
ck('第 3 段推进到第 3 行（不卡死）', a6.idx === 3, 'idx=' + a6.idx);
ck('逐段揭示期间后续行仍 hold（不整段闪出）',
  H.ctx.__lineMode(LINES[3], 3, true) === 'typing');

console.log('\n[2] 改前改后行为差异证据（同一段 seg 失配序列）');
const bakName = fs.readdirSync(path.join(ROOT, 'js'))
  .filter(f => /^chatroom\.html\.bak\.subtitle-/.test(f)).sort().pop();
if (bakName) {
  const oldSrc = [...fs.readFileSync(path.join(ROOT, 'js', bakName), 'utf8').matchAll(SCRIPTS)]
    .map(m => m[1]).join('\n');
  const O = load(oldSrc);
  O.reset();
  const oldSeq = [];
  for (let i = 1; i <= 6; i++) {
    const s = O.step({ seg: '@@@无关@@@' + i, frac: 0.4, playing: true, speaking: true, ts: tick() }, LINES);
    oldSeq.push(s.idx);
  }
  const newSeq = [];
  H.reset();
  for (let i = 1; i <= 6; i++) {
    const s = H.step({ seg: '@@@无关@@@' + i, segToken: i, frac: 0.4, playing: true, speaking: true, ts: tick() }, LINES);
    newSeq.push(s.idx);
  }
  ck('【证据】旧逻辑游标卡死在首行', oldSeq.every(x => x === oldSeq[0]), '旧 idx=' + oldSeq.join(','));
  ck('【证据】新逻辑游标逐段前进', newSeq[1] > newSeq[0] && newSeq[2] > newSeq[1], '新 idx=' + newSeq.join(','));
  console.log('    旧 idx 序列: [' + oldSeq.join(', ') + ']');
  console.log('    新 idx 序列: [' + newSeq.join(', ') + ']');
} else {
  // 改前备份是当时的一次性证据文件，已随仓库清理删除。
  // 行为守卫由 [1]/[3]/[8] 覆盖，这里只跳过"对比证据"，不算失败。
  console.log('    SKIP 没有改前备份（.bak.subtitle-*），跳过新旧对比证据');
}

console.log('\n[3] 打断冻结');
H.reset();
H.step({ seg: 'a', segToken: 1, frac: 0.5, playing: true, speaking: true, ts: tick() }, LINES);
const shownAtInterrupt = H.ctx.__typer.shown;
H.step({ seg: 'a', segToken: 1, interrupting: true, frac: 0.5, playing: false, speaking: false, ts: tick() }, LINES);
ck('打断立即冻结当前行（停在那词）', H.ctx.__typer.frozen === true && H.ctx.__typer.shown === shownAtInterrupt,
  'shown=' + H.ctx.__typer.shown);
const afterLock = H.step({ seg: 'a', segToken: 1, frac: 0.9, playing: true, speaking: true, ts: tick() }, LINES);
ck('打断锁期间进度不推进', afterLock.idx === 1 && afterLock.shown === shownAtInterrupt,
  'idx=' + afterLock.idx + ' shown=' + afterLock.shown);
H.ctx.__ttsInterruptLockAt = 0;
const afterUnlock = H.step({ seg: 'b', segToken: 2, frac: 0.1, playing: true, speaking: true, ts: tick() }, LINES);
ck('锁过期后新段推进到下一行（字幕恢复）', afterUnlock.idx === 2, 'idx=' + afterUnlock.idx);

console.log('\n[4] 进度桥断开超时兜底（防白屏）');
H.reset();
H.step({ seg: 'a', segToken: 1, frac: 0.3, playing: true, speaking: true, ts: tick() }, LINES);
H.ctx.__ttsLastAt = Date.now() - 13000;
H.ctx.__lastEffectiveProgressAt = 0;
H.ctx.__holdCursorAt = Date.now() - 13000;
H.ctx.__holdCursorIdx = 1;
H.ctx.paint(H.sandbox.document.getElementById('chat'), LINES, 'chat');
ck('超时后闸门放开', H.ctx.__ttsGating() === false);
ck('游标及之前已播行整行显示', H.ctx.__lineMode(LINES[1], 1, false) === 'full');
ck('游标之后未播行仍 hold（不整段全蹦）',
  H.ctx.__lineMode(LINES[2], 2, false) === 'hold'
  && H.ctx.__lineMode(LINES[3], 3, false) === 'hold');

console.log('\n[5] 纯文本无 TTS（桥从未就绪）整行显示');
H.reset();
const chatEl5 = H.sandbox.document.getElementById('chat');
H.ctx.paint(chatEl5, LINES, 'chat');
const modes5a = [1, 2, 3].map(i => H.ctx.__lineMode(LINES[i], i, false));
ck('纯文本兜底绝不出现 hold 空占位', modes5a.every(m => m !== 'hold'), JSON.stringify(modes5a));
ck('fixed 兜底打字机接管首行（不白屏）', modes5a[0] === 'typing');
for (let i = 0; i < 20; i++) H.ctx.paint(chatEl5, LINES, 'chat');
const modes5b = [1, 2, 3].map(i => H.ctx.__lineMode(LINES[i], i, false));
ck('兜底打字机揭示完毕后全部整行', modes5b.every(m => m === 'full'), JSON.stringify(modes5b));

console.log('\n[6] 翻译后流式仍正常');
H.reset();
const TRANSLATED = LINES.slice();
TRANSLATED[2] = '[13:00:03] neuro: 泽塔伊塔西塔译文内容。';
H.step({ seg: '@@@', segToken: 1, frac: 0, playing: false, speaking: true, ts: tick() }, LINES);
const tr = H.step({ seg: '@@@', segToken: 2, frac: 0.5, playing: true, speaking: true, ts: tick() }, LINES);
ck('翻译后 segToken 仍能推进游标', tr.idx === 2, 'idx=' + tr.idx);
H.ctx.paint(H.sandbox.document.getElementById('chat'), TRANSLATED, 'chat');
ck('译文行正常渲染（不白屏）', H.ctx.__lineMode(TRANSLATED[2], 2, true) === 'typing');

console.log('\n[7] 无 segToken 向后兼容（旧桥 / 轮询快照）');
H.reset();
const c1 = H.step({ seg: 'Alpha beta gamma delta epsilon.', frac: 0.4, playing: true, speaking: true, ts: tick() }, LINES);
const c2 = H.step({ seg: 'Second line zeta eta theta iota.', frac: 0.5, playing: true, speaking: true, ts: tick() }, LINES);
ck('旧 seg 文本匹配路径仍可定位并推进', c1.idx === 1 && c2.idx === 2, '[' + c1.idx + ',' + c2.idx + ']');

console.log('\n[8] 历史修复回归（不回退）');
H.reset();
H.step({ seg: 'x', segToken: 1, frac: 0, playing: false, speaking: true, ts: tick() }, LINES);
const synthModes = [1, 2, 3].map(i => H.ctx.__lineMode(LINES[i], i, true));
ck('合成期后两行 hold、当前行 0 词（不整段先闪出）',
  synthModes[1] === 'hold' && synthModes[2] === 'hold' && H.ctx.__typingText() === '',
  JSON.stringify(synthModes) + ' text=' + JSON.stringify(H.ctx.__typingText()));
H.step({ seg: 'x', segToken: 2, frac: 0.3, playing: true, speaking: true, ts: tick() }, LINES);
H.step({ seg: 'x', segToken: 3, frac: 0.3, playing: true, speaking: true, ts: tick() }, LINES);
H.step({ seg: '', segToken: 3, frac: 0, playing: false, speaking: false, ts: tick() }, LINES);
const endModes = [1, 2, 3].map(i => H.ctx.__lineMode(LINES[i], i, true));
ck('整轮说完无 hold、全部整行显示', endModes.every(m => m === 'full'), JSON.stringify(endModes));
ck('typing 行用固定 id 承载（增量 DOM 治卡顿）', /id="__typing-live"/.test(html));
ck('结构签名不含已揭示词数', /modes\[i\]\s*\+\s*'\|'\s*\+\s*l/.test(html));
ck('轮询不无条件覆盖实时进度', /if\s*\(!__ttsLive\(\)\)\s*__applyTtsProgress\(p\.tts/.test(html));

console.log('\n==== PASS ' + pass + ' / FAIL ' + fail + ' ====');
process.exit(fail ? 1 : 0);
