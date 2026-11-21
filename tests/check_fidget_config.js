'use strict'

const path = require('path')
const { ModelInteractionController } = require(path.join(__dirname, '..', 'js', 'model-interaction.js'))

let fails = 0
function check(name, cond, extra) {
  if (cond) console.log('  PASS ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')) }
}

console.log('[1] 显式传 config：开关能被读到')
{
  const on = new ModelInteractionController({ ui: { idle_fidget: true } })
  check('idle_fidget=true 读到了', !!(on.config && on.config.ui && on.config.ui.idle_fidget === true))
  const off = new ModelInteractionController({ ui: { idle_fidget: false } })
  check('idle_fidget=false 读到了', off.config.ui.idle_fidget === false)
}

console.log('[2] 不传 config：退回 config-loader，不能崩、不能是 undefined')
{
  let c
  let threw = null
  try { c = new ModelInteractionController() } catch (e) { threw = e }
  check('构造不抛异常', threw === null, threw && threw.message)
  check('this.config 是对象', !!c && c.config && typeof c.config === 'object',
    c && String(c.config))
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
