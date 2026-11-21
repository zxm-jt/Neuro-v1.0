const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const vc = read('js/voice-chat.js');
const asr = read('js/asr-processor.js');
const cr = read('js/command-router.js');
const im = read('js/interrupt-manager.js');

let PASS = 0, FAIL = 0;
function ck(name, cond, extra) {
  if (cond) { PASS++; console.log('  \u2713 ' + name); }
  else { FAIL++; console.log('  \u2717 FAIL: ' + name + (extra ? '  (' + extra + ')' : '')); }
}

console.log('\n[A] 每轮重述后缀在 trimMessages 重建【之后】注入');
const iDecl = vc.indexOf("let _perTurnSuffix = '';");
const iHuman = vc.indexOf('_perTurnSuffix +=');
const iConv = vc.indexOf("【Current conversation state】");
const iRebuild = vc.indexOf('messagesForAPI = JSON.parse(JSON.stringify(this.messages));', iDecl);
const iApply = vc.indexOf('if (_perTurnSuffix) {', iRebuild);
ck('声明在重建之前', iDecl > 0 && iDecl < iRebuild);
ck('Humanity 累加到后缀（不再直接写 messagesForAPI）', iHuman > iDecl && iHuman < iRebuild);
ck('ConversationState 累加到后缀', iConv > iDecl && iConv < iRebuild);
ck('重建之后才把后缀补回 system', iApply > iRebuild);
ck('旧版直接写 messagesForAPI[_si] 的注入已移除',
   !/messagesForAPI\[_si\]\.content \+=/.test(vc));
ck('补回时兼容无 system 的情况（unshift）',
   /messagesForAPI\.unshift\(\{ role: 'system'/.test(vc));

console.log('\n[B] 打断：跨句缓冲清空 + 段间隙零等待 + 生成中判忙');
ck('存在 _clearCrossPending 方法', /_clearCrossPending\(reason = ''\)/.test(asr));
ck('她开始说话（pauseRecording）时清跨句缓冲',
   /this\._clearCrossPending\('她开始说话'\)/.test(asr));
ck('文本门控打断时清跨句缓冲',
   /this\._clearCrossPending\('文本门控打断'\)/.test(asr));
ck('immediate 判据纳入 isTtsPlaying（段间隙插话不再等 4.5~10.5s）',
   /const immediate = .*\|\| _ttsPlayingNowQ/.test(asr)
   && /_ttsPlayingNowQ = .*isTtsPlaying/.test(asr));
ck('_sheIdleNow 无条件先判 TTS/录音（注入回退信号后不漏判）',
   /if \(this\.isProcessingAudio \|\| ttsPlaying\) return false;/.test(asr));
ck('voice-chat 注入了 isSheReplying（旧版全项目从未注入）',
   /asrProcessor\.isSheReplying = \(\) => !!this\._abortController/.test(vc));

try {
  const { ASRProcessor } = require('../js/asr-processor.js');
  const proto = ASRProcessor.prototype;
  const ctx = {
    _crossPending: { text: '上一句残留', raw: '上一句残留', startedAt: 0, duringTts: false },
    _crossTimer: setTimeout(() => {}, 99999),
  };
  proto._clearCrossPending.call(ctx, 'test');
  ck('_clearCrossPending 清空缓冲', ctx._crossPending === null);
  ck('_clearCrossPending 清掉定时器', ctx._crossTimer === null);
} catch (e) {
  ck('_clearCrossPending 可执行', false, String(e));
}

// ---------- C: 打断状态异常路径复位 ----------
console.log('\n[C] 打断状态：finally / 永久停 / 续说 三条路径都复位');
ck('sendToLLM finally 统一清 _lastInterrupt + _turnWasInterrupted',
   /this\._lastInterrupt = null;\s*\n\s*this\._turnWasInterrupted = false;/.test(vc));
ck('永久停分支清 _turnWasInterrupted',
   /this\.abortCurrentReply\(\);[\s\S]{0,600}?this\._cancelResume\(\);[\s\S]{0,200}?this\._turnWasInterrupted = false;[\s\S]{0,40}?return;/.test(vc));
ck('永久停分支补 ttsProcessor.reset()',
   /ttsProcessor && this\.ttsProcessor\.reset && this\.ttsProcessor\.reset\(\)/.test(vc));
ck('5 秒续说路径 return 前清标志',
   /this\._lastInterrupt = null;\s*this\._turnWasInterrupted = false;\s*this\._scheduleResume\(/.test(vc));

console.log('\n[D] 可持续：连续打断时 userAdds 有界');
ck('MAX_USER_ADDS 常量存在', /const MAX_USER_ADDS = 3;/.test(im));
ck('addUserInput 截断', /this\.userAdds\.splice\(0, this\.userAdds\.length - MAX_USER_ADDS\)/.test(im));
ck('mergedUserAdds 取最近 3 条 + 长度封顶',
   /this\.userAdds\.slice\(-MAX_USER_ADDS\).*\.slice\(0, 240\)/.test(im));

console.log('\n[E] 桌面回执：保留历史 / 自带 op / 丢弃也回执');
ck('回执保留完整裁剪后历史（不再是 2 条消息桩）',
   /\.slice\(-60\)/.test(cr) && /neuro_memory_mode: 'chat'/.test(cr));
ck('回执自带 op（后端重启仍能判定静默动作）',
   /desktop_cmd_result: \{[\s\S]{0,200}op: _op/.test(cr));
ck('_opById 按 id 记录并有界', /const _opById = new Map\(\)/.test(cr)
   && /_opById\.size > 256/.test(cr));
ck('重复 / 过期指令也回执 ok:false（后端不再悬空）',
   /dropped: duplicate command id/.test(cr) && /dropped: command expired/.test(cr));

console.log('\n===== ' + PASS + ' passed, ' + FAIL + ' failed =====');
process.exit(FAIL > 0 ? 1 : 0);
