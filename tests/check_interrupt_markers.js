'use strict'

const path = require('path')
const { classifyInterruption } = require(path.join(__dirname, '..', 'js', 'interrupt-manager.js'))

let fails = 0
function run(text) {
  return classifyInterruption(text, { isSpeaking: true })
}
function report(ok, text, r, want) {
  if (ok) {
    console.log(`  PASS "${text}" → ${r.kind} (${r.reason})`)
  } else {
    fails++
    console.log(`  FAIL "${text}" → ${r.kind} (${r.reason})，期望 ${want}`)
  }
}
function expectNotRedirect(text) {
  const r = run(text)
  report(!String(r.reason).includes('改向信号'), text, r, '不命中改向信号')
}
// 断言：理由里【必须】出现"改向信号"，且 kind=interrupt
function expectRedirect(text) {
  const r = run(text)
  report(String(r.reason).includes('改向信号') && r.kind === 'interrupt', text, r, '命中改向信号且 interrupt')
}

console.log('[1] 含 no/but 的普通词：不允许命中"改向信号"')
;['I know the button', 'technology is interesting', 'nothing much', 'snow falling']
  .forEach(expectNotRedirect)

console.log('[2] 短词靠词边界区分：know ≠ no')
{
  const r1 = run('know')
  report(r1.kind === 'ack', 'know', r1, 'ack')
  expectRedirect('no')
}

console.log('[3] 真正的改向信号：必须命中"改向信号"')
;['no, wait', 'but I meant the other one', 'actually try again', '不对，换一个', '等等我想想']
  .forEach(expectRedirect)

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
