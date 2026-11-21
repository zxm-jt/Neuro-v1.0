'use strict'

const path = require('path')
const { EnhancedTextProcessor } = require(path.join(__dirname, '..', 'js', 'tts-processor.js'))

let fails = 0
function check(name, cond, extra) {
  if (cond) console.log('  PASS ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')) }
}

function make(cfg) {
  return new EnhancedTextProcessor('http://127.0.0.1:6006/v3', () => {}, () => {}, () => {}, cfg || {})
}

const runOn = ('word '.repeat(120))

console.log('[1] 默认上限 300：600 字符 run-on 被切成多段，且每段 ≤300')
{
  const p = make({})
  const segs = p._smartSplit(runOn)
  check('切成了多段', segs.length >= 2, 'n=' + segs.length)
  check('每段 ≤ 300', segs.every((s) => s.length <= 300), JSON.stringify(segs.map((s) => s.length)))
  check('拼回去与原文字符数一致', segs.join('').replace(/\s+/g, ' ').length === runOn.replace(/\s+/g, ' ').length,
    String(segs.join('').length) + ' vs ' + String(runOn.length))
}

console.log('[2] 配成 180：更早切，段更多、每段更短')
{
  const p = make({ tts: { hard_split_chars: 180 } })
  const segs = p._smartSplit(runOn)
  check('段数比默认多', segs.length >= 3, 'n=' + segs.length)
  check('每段 ≤ 180', segs.every((s) => s.length <= 180), JSON.stringify(segs.map((s) => s.length)))
}

console.log('[3] 非法配置回落到默认 300')
{
  const a = make({ tts: { hard_split_chars: 5 } })
  const b = make({ tts: { hard_split_chars: 'abc' } })
  const c = make({ tts: { hard_split_chars: 9999 } })
  check('5 → 用默认(段≤300)', a._smartSplit(runOn).every((s) => s.length <= 300))
  check('abc → 用默认', b._smartSplit(runOn).every((s) => s.length <= 300))
  check('9999 → 夹到 600（一件整段跑完）', c._smartSplit(runOn).length <= 2, 'n=' + c._smartSplit(runOn).length)
}

console.log('[4] 正常短句不受影响（永远整段一次合成）')
{
  const p = make({ tts: { hard_split_chars: 180 } })
  const short = 'Mmm. That is a short reply.'
  check('短句 = 1 段', p._smartSplit(short).length === 1, JSON.stringify(p._smartSplit(short)))
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
