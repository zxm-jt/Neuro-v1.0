'use strict'

const path = require('path')
const { EnhancedTextProcessor } = require(path.join(__dirname, '..', 'js', 'tts-processor.js'))

let fails = 0
function check(name, cond, extra) {
  if (cond) console.log('  PASS ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')) }
}

function makeProc() {
  return new EnhancedTextProcessor('http://127.0.0.1:6006/v3', () => {}, () => {}, () => {}, {})
}

console.log('[1] 删掉的是"下一个该推"的序号 → 游标必须跳过空洞')
{
  const p = makeProc()
  p._ttsSeq = 5
  p._nextSeqToPush = 1
  p._pendingAudios = new Map([
    [1, { turn: 1 }], [2, { turn: 1 }], [3, { turn: 2 }], [4, { turn: 2 }],
  ])
  p.discardStaleTurns(2)
  check('key 1/2 已删除', !p._pendingAudios.has(1) && !p._pendingAudios.has(2))
  check('游标推进到 3', p._nextSeqToPush === 3, 'got=' + p._nextSeqToPush)
}

console.log('[2] 全部被丢弃 → 游标对齐到最新 seq，不会等一个不存在的号')
{
  const p = makeProc()
  p._ttsSeq = 7
  p._nextSeqToPush = 4
  p._pendingAudios = new Map([[4, { turn: 1 }], [5, { turn: 1 }], [6, { turn: 1 }]])
  p.discardStaleTurns(2)
  check('表已清空', p._pendingAudios.size === 0)
  check('游标 = _ttsSeq(7)', p._nextSeqToPush === 7, 'got=' + p._nextSeqToPush)
}

console.log('[3] 没删到游标前面的号 → 游标不动')
{
  const p = makeProc()
  p._ttsSeq = 5
  p._nextSeqToPush = 0
  p._pendingAudios = new Map([[0, { turn: 2 }], [1, { turn: 2 }]])
  p.discardStaleTurns(2)
  check('游标仍为 0', p._nextSeqToPush === 0, 'got=' + p._nextSeqToPush)
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
