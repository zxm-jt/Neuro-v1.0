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

// 默认缩放：emotion_pitch_scale=0（音高跟随 config.tts.pitch，不随情绪变），
//          emotion_rate_scale=0.45（保留 45% 的情绪语速差）。
console.log('[1] 默认 base（+42Hz / -15%）下，情绪只做小幅偏移')
{
  const p = make({ tts: { pitch: '+42Hz', rate: '-15%' } })
  const happy = p._resolveProsody('happy')
  check('happy → +42Hz/-6%', happy.pitch === '+42Hz' && happy.rate === '-6%', JSON.stringify(happy))
  const sad = p._resolveProsody('sad')
  check('sad → +42Hz/-14%', sad.pitch === '+42Hz' && sad.rate === '-14%', JSON.stringify(sad))
  check('neutral → null（不覆盖 base）', p._resolveProsody('neutral') === null)
  check('未知情绪 → null', p._resolveProsody('whatever') === null)
}

console.log('[2] 用户把 base 调慢/调低，情绪句整体跟着走（不再跳变）')
{
  const p = make({ tts: { pitch: '+30Hz', rate: '-25%' } })
  const happy = p._resolveProsody('happy')
  check('happy → +30Hz/-16%', happy.pitch === '+30Hz' && happy.rate === '-16%', JSON.stringify(happy))
  const neutralBaseRate = -25
  const happyRate = Number(/-?\d+/.exec(happy.rate)[0])
  check('情绪句与中性句的语速差 ≈ 9 个百分点（21 × 0.45）',
    Math.abs((happyRate - neutralBaseRate) - 9) <= 1, `diff=${happyRate - neutralBaseRate}`)
}

console.log('[2b] 缩放系数可在 config.tts 里覆盖')
{
  const p = make({ tts: { pitch: '+42Hz', rate: '-15%', emotion_pitch_scale: 1, emotion_rate_scale: 1 } })
  const happy = p._resolveProsody('happy')
  check('scale=1 时回到 +48Hz/+6%', happy.pitch === '+48Hz' && happy.rate === '+6%', JSON.stringify(happy))
}

console.log('[3] 极端 base 会被夹在可懂范围内')
{
  const p = make({ tts: { pitch: '+85Hz', rate: '+35%' } })
  const excited = p._resolveProsody('excited')
  const rate = Number(/-?\d+/.exec(excited.rate)[0])
  const pitch = Number(/-?\d+/.exec(excited.pitch)[0])
  check('rate 夹到 ≤40', rate <= 40, excited.rate)
  check('pitch 夹到 ≤90', pitch <= 90, excited.pitch)
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
