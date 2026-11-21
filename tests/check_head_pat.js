'use strict'

const path = require('path')

global.window = global.window || { innerWidth: 1920, innerHeight: 1080 }

const { ModelInteractionController } = require(path.join(__dirname, '..', 'js', 'model-interaction.js'))

let fails = 0
function check(name, cond, extra) {
  if (cond) console.log('  PASS ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')) }
}

function makeCtl() {
  const c = new ModelInteractionController({ ui: {} })
  c.model = { width: 400, height: 800, x: 600, y: 200 }
  c.interactionX = 600
  c.interactionY = 200
  c.interactionWidth = 400
  c.interactionHeight = 800
  return c
}

console.log('[1] 头部中点 → 摸头')
{
  const c = makeCtl()
  check('头中点 (800,280) 判为摸头', c._isHeadHit(800, 280) === true)
  check('头顶 (800,205) 判为摸头', c._isHeadHit(800, 205) === true)
}

console.log('[2] 身体/边缘 → 不是摸头')
{
  const c = makeCtl()
  check('胸部 (800,700) 不是摸头', c._isHeadHit(800, 700) === false)
  check('左侧 (620,280) 不是摸头（太靠边）', c._isHeadHit(620, 280) === false)
  check('右侧 (980,280) 不是摸头（太靠边）', c._isHeadHit(980, 280) === false)
}

console.log('[3] 判定框外 → 一律 false（绝不吃掉桌面点击）')
{
  const c = makeCtl()
  check('框左外 (100,280)', c._isHeadHit(100, 280) === false)
  check('框上方 (800,50)', c._isHeadHit(800, 50) === false)
  check('框右下外 (1500,1200)', c._isHeadHit(1500, 1200) === false)
}

console.log('[4] 判定框还没算出来（模型未就绪）→ false')
{
  const c = new ModelInteractionController({ ui: {} })
  c.model = null
  check('无模型时 false', c._isHeadHit(800, 280) === false)
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
