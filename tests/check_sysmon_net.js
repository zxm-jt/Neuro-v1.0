'use strict'

const path = require('path')
const mon = require(path.join(__dirname, '..', 'js', 'sys-monitor.js'))

let fails = 0
function check(name, cond, extra) {
  if (cond) console.log('  PASS ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')) }
}

async function main() {
  console.log('[1] 能读到累计收发字节')
  const c = await mon._readNetCounters()
  check('返回了对象', !!c, String(c))
  if (c) {
    check('rx > 0（收到过数据）', c.rx > 0, 'rx=' + c.rx)
    check('tx > 0（发出过数据）', c.tx > 0, 'tx=' + c.tx)
  }

  console.log('[2] 两次刷新之间产生了速率（有流量时）')
  await mon._refreshNetRate()
  const before = mon.getNet()
  try {
    await fetch('http://127.0.0.1:4668/').catch(() => {})
  } catch (e) {   }
  await new Promise((r) => setTimeout(r, 1200))
  await mon._refreshNetRate()
  const after = mon.getNet()
  check('getNet() 返回数值', Number.isFinite(after.rx) && Number.isFinite(after.tx),
    JSON.stringify(after))
  check('速率非负', after.rx >= 0 && after.tx >= 0, JSON.stringify(after))
  console.log('    before=' + JSON.stringify(before) + '  after=' + JSON.stringify(after) + ' B/s')

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => { console.error('测试自身异常:', e); process.exit(2) })
