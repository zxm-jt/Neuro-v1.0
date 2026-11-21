const fs = require('fs')
const path = require('path')

let pass = 0, fail = 0
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name) }
}
function has(file, needle) {
  return fs.readFileSync(file, 'utf8').includes(needle)
}

const ROOT = path.join(__dirname, '..')
const APP = path.join(ROOT, 'js', 'app.js')
const MAIN = path.join(ROOT, 'js', 'main.js')
const PUMP = path.join(ROOT, 'js', 'vision-pump.js')
const ROOM = path.join(ROOT, 'js', 'chatroom.js')

console.log('=== 修复① 开场白人格 ===')

const appSrc = fs.readFileSync(APP, 'utf8')
const flIdx = appSrc.indexOf('async function fetchLine')
const flBlock = appSrc.slice(flIdx, flIdx + 2000)

ok(!flBlock.includes('_memoryCtx'),
   'fetchLine 不再注入记忆(_memoryCtx 已从函数体移除)')
ok(flBlock.includes('config.llm.system_prompt'),
   'fetchLine 仍以 system_prompt 为基础')
ok(!appSrc.includes('let _memoryCtx'),
   '_memoryCtx 死代码已删除')
ok(!appSrc.includes('_loadMemoryCtx().finally'),
   '开场不再先加载记忆再 greet')

const gIdx = appSrc.indexOf('async function greet')
const gBlock = appSrc.slice(gIdx, gIdx + 1800)
ok(!gBlock.includes('必须用英文。语气要符合你的人格'),
   'greet 指令不再重复人格描述（稀释人格）')
ok(gBlock.includes('Open the conversation as Neuro'),
   'greet 指令改为英文、以 Neuro 身份开场')

const pIdx = appSrc.indexOf('async function proactiveSpeak')
const pBlock = appSrc.slice(pIdx, pIdx + 2200)
ok(!pBlock.includes('就像朋友间自然搭话'),
   'proactiveSpeak 指令不再是中文')
ok(pBlock.includes('Say ONE line, in English, as Neuro'),
   'proactiveSpeak 指令改为英文')

console.log('=== 修复② 截屏时窗口可见 ===')

ok(!has(MAIN, 'win.setContentProtection(true)'),
   '主窗口不再常开 setContentProtection')
ok(has(ROOM, "this.protect = opts.protect !== false"),
   'ChatRoom 保留 protect 开关（默认 false 不触发）')
ok(has(path.join(ROOT, 'js', 'chat-monitor.js'), "this.protect = opts.protect !== false"),
   'ChatMonitor 保留 protect 开关')

ok(!has(MAIN, '桌宠窗口已从屏幕捕获中排除'),
   '主窗口的常开排除日志已移除')

const pumpSrc = fs.readFileSync(PUMP, 'utf8')
ok(pumpSrc.includes('this.protectWindows = typeof opts.protectWindows ==='),
   'pump 接受 protectWindows 回调')
ok(pumpSrc.includes('this.protectWindows(true)'),
   '抓帧前开启保护')
ok(pumpSrc.includes('this.protectWindows(false)'),
   '抓帧后恢复可见')
ok(/finally \{/.test(pumpSrc),
   '保护恢复在 finally 中（异常也恢复）')

const mainSrc = fs.readFileSync(MAIN, 'utf8')
ok(mainSrc.includes('protectWindows: _excludeSelf ?'),
   'main.js 注入 protectWindows 回调')
ok(mainSrc.includes("_apply(mainWindowRef)") && mainSrc.includes("_apply(chatMonitor && chatMonitor.win)") && mainSrc.includes("_apply(chatRoom && chatRoom.win)"),
   '回调覆盖主窗口/ChatMonitor/ChatRoom 三个窗口')
ok(mainSrc.includes('chatMonitor = new ChatMonitor({') &&
   /new ChatMonitor\(\{\s*\n\s*protect: false/.test(mainSrc),
   'ChatMonitor 创建时 protect:false（不再常开）')
ok(mainSrc.includes('path.join(appPath(), \'.quit_request\')'),
   'ChatMonitor 的 CLOSE 写 .quit_request 标记（与桌面 bat 同一链路）')

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
