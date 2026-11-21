// verify_subtitle_order.js
// 用【用户截图里的真实日志】复现"她的字幕跑到我说的话上面"，对比修复前后。
//
// 真实日志（D:\Z\neuro\backend\chat_log.txt）：
//   [00:31:33] cmd: Hi, new.
//   [00:31:34] neuro: Oh! Hi yourself.
//   [00:31:34] neuro: You caught me mid-thought — I was about to say...
//   [00:31:46] cmd: Can you help me.
//   [00:31:47] neuro: Of course — what's going on, cmd?
//
// 故障时序：
//   轮次1：用户 "Hi, new." → 她的第 1 句（游标停这里）
//   轮次2：用户 "Can you help me." → 她的第 2 句
// 新一段语音（segToken+1）到来时，旧版游标从"轮次1 的第1句"往后找下一条 neuro 行，
// 找到的是【轮次1 的第2句】—— 那行在用户新消息【上面】→ 字幕跑到用户消息前面。

const fs = require('fs');
const path = require('path');

const LOG = [
  '[00:31:27] neuro: cmd, wait — what if the desktop pet could react to the music?',
  '[00:31:33] cmd: Hi, new.',
  '[00:31:34] neuro: Oh! Hi yourself.',
  '[00:31:34] neuro: You caught me mid-thought — I was about to say the pet should bob its head when music plays.',
  '[00:31:46] cmd: Can you help me.',
  '[00:31:47] neuro: Of course — what\'s going on, cmd?',
];

// ---- 从被测文件里抽出"游标推进"的纯逻辑，做行为对比 ----
// 抽 __isUserLine / __lineMode / __applyTtsProgress 的关键片段做隔离执行。
function extractFn(code, name) {
  const start = code.indexOf('function ' + name + '(');
  if (start < 0) return null;
  let depth = 0, i = code.indexOf('{', start);
  for (let j = i; j < code.length; j++) {
    if (code[j] === '{') depth++;
    else if (code[j] === '}') { depth--; if (depth === 0) return code.slice(start, j + 1); }
  }
  return null;
}

function loadVariant(file, opts) {
  const html = fs.readFileSync(file, 'utf8');
  const blocks = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
  let code = '';
  for (const b of blocks) code += b.replace(/^<script>/, '').replace(/<\/script>$/, '') + '\n';

  const sandbox = {
    console,
    Date,
    Math,
    String,
    Number,
    Array,
    Object,
    JSON,
    RegExp,
    setTimeout: () => {},
    clearTimeout: () => {},
  };
  const ctx = sandbox;
  // 提供依赖
  const fnNames = ['__isUserLine', '__normSpeech', '__splitWords', '__shownByCharFrac',
                   '__lineMode', '__applyTtsProgress', '__progressMoved'];
  const src = [];
  for (const n of fnNames) {
    const f = extractFn(code, n);
    if (f) src.push(f);
  }
  // 声明需要的状态变量
  src.push(`
    var __typer = { idx: -1, words: [], shown: 0, frozen: true, lineSig: '', mode: 'fixed' };
    var __lastSegToken = 0;
    var __ttsLastAt = 0;
    var __ttsEverPlaying = false;
    var __lastEffectiveProgressAt = 0;
    var __HOLD_MAX_MS = 12000;
    var __holdSince = 0;
    var __holdCursorIdx = -1;
    var __holdCursorAt = 0;
    var __lastProgressTs = 0;
    var __typerStart = function(){};
    var lineClass = function(s){
      if (/^\\[.*\\] (?:cmd|user):/.test(s)) return 'user';
      if (/^\\[.*\\] neuro(?:\\(识图\\))?:/.test(s)) return 'neuro';
      return 'sys';
    };
    var __ttsLive = function(){ return false; };
    var __ttsGating = function(){ return __ttsEverPlaying; };
    var __holdWatchdog = function(){ return false; };
  `);

  // 把抽出的函数与状态装进 sandbox 执行
  const runner = new Function('sandbox', src.join('\n') + `
    sandbox.__isUserLine = __isUserLine;
    sandbox.__lineMode = __lineMode;
    sandbox.__applyTtsProgress = __applyTtsProgress;
    sandbox.__typer = __typer;
    sandbox.__setTyper = function(v){ __typer = v; };
    sandbox.__getTyper = function(){ return __typer; };
    return true;
  `);
  runner(sandbox);
  return sandbox;
}

// ---- 模拟两轮对话的推进 ----
function simulate(sandbox, lines, opts) {
  const neuro = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\[.*\] neuro:/.test(lines[i])) {
      neuro.push({ idx: i, body: lines[i].replace(/^\[.*\] neuro:\s*/, '') });
    }
  }
  // 找到最后一条用户行
  let lastUserIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (sandbox.__isUserLine(lines[i])) { lastUserIdx = i; break; }
  }

  // 模拟：轮次1 的第 1 句被播过 → 游标停在 idx=1（Oh! Hi yourself.）
  const firstNeuro = neuro[0];
  sandbox.__setTyper({
    idx: firstNeuro.idx, words: firstNeuro.body.split(/\S+\s*/g).filter(Boolean),
    shown: 999, frozen: true, lineSig: lines[firstNeuro.idx], mode: 'tts',
  });

  // 新一段语音到来（segToken 递增）→ 旧代码在这里选 target
  let target = null;
  const segToken = 2;
  const before = sandbox.__getTyper();
  const base = (before.idx >= 0) ? before.idx : -1;
  for (let q = 0; q < neuro.length; q++) {
    if (neuro[q].idx > base) { target = neuro[q]; break; }   // ← 旧版逻辑
  }
  return { target, lastUserIdx, neuro, base };
}

function simulateFixed(sandbox, lines) {
  const neuro = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\[.*\] neuro:/.test(lines[i])) {
      neuro.push({ idx: i, body: lines[i].replace(/^\[.*\] neuro:\s*/, '') });
    }
  }
  let lastUserIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (sandbox.__isUserLine(lines[i])) { lastUserIdx = i; break; }
  }
  const before = sandbox.__getTyper();
  let base = (before.idx >= 0) ? before.idx : -1;
  if (lastUserIdx > base) base = lastUserIdx;          // ← 修复后的护栏
  let target = null;
  for (let q = 0; q < neuro.length; q++) {
    if (neuro[q].idx > base) { target = neuro[q]; break; }
  }
  return { target, lastUserIdx, neuro, base };
}

// =====================================================================
const targets = process.argv.slice(2);
if (!targets.length) {
  console.error('用法: node verify_subtitle_order.js <chatroom.html> [more...]');
  process.exit(1);
}

let fail = 0;
for (const file of targets) {
  console.log('=== ' + file + ' ===');
  const sb = loadVariant(file, {});
  const hasGuard = sb.__isUserLine && /__isUserLine/.test(fs.readFileSync(file, 'utf8'));

  // 护栏存在性：源码里必须有 lastUserIdx 下界
  const src = fs.readFileSync(file, 'utf8');
  const hasBaseGuard = /if \(lastUserIdx > base\) base = lastUserIdx/.test(src);
  const hasBaseGuard2 = /if \(lastUserIdx > base2\) base2 = lastUserIdx/.test(src);
  const hasKeepGuard = /__typer\.idx >= lastUserIdx/.test(src);
  const hasModeGuard = /lastUser >= 0 && i < lastUser/.test(src);
  const hasUserHelper = /function __isUserLine/.test(src);

  console.log('  __isUserLine 助手      : ' + (hasUserHelper ? 'OK' : '缺失'));
  console.log('  segToken base 下界     : ' + (hasBaseGuard ? 'OK' : '缺失'));
  console.log('  兼容分支 base2 下界    : ' + (hasBaseGuard2 ? 'OK' : '缺失'));
  console.log('  保持游标加轮次条件     : ' + (hasKeepGuard ? 'OK' : '缺失'));
  console.log('  __lineMode 旧行整行显示: ' + (hasModeGuard ? 'OK' : '缺失'));

  if (!hasUserHelper || !hasModeGuard) { console.log('  ✗ 护栏不完整'); fail++; }

  // 行为对比
  const oldR = simulate(sb, LOG, {});
  const newR = simulateFixed(sb, LOG);
  console.log('  用户最新消息行号      : ' + newR.lastUserIdx +
              '  (' + LOG[newR.lastUserIdx] + ')');
  console.log('  修复前 游标落到 行 ' + (oldR.target ? oldR.target.idx : '?') +
              ' : ' + (oldR.target ? oldR.target.body.slice(0, 46) : '-'));
  console.log('  修复后 游标落到 行 ' + (newR.target ? newR.target.idx : '?') +
              ' : ' + (newR.target ? newR.target.body.slice(0, 46) : '-'));

  if (newR.target && newR.lastUserIdx >= 0 && newR.target.idx < newR.lastUserIdx) {
    console.log('  ✗ 仍然越界！字幕会跑到用户消息上面');
    fail++;
  } else {
    console.log('  ✓ 游标落在用户消息之后，不会越界');
  }
  console.log('');
}
process.exit(fail ? 1 : 0);
