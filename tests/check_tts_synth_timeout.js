'use strict'

const path = require('path')

// tts-processor 在模块层会碰 DOM 吗？不碰（只在方法里用）。
const { EnhancedTextProcessor } = require(path.join(__dirname, '..', 'js', 'tts-processor.js'))

let failures = 0
function check(name, cond, extra) {
  if (cond) {
    console.log('  PASS ' + name)
  } else {
    failures++
    console.log('  FAIL ' + name + (extra ? '  → ' + extra : ''))
  }
}

async function main() {
  console.log('[1] 挂起的 fetch：超时后必须返回 null')
  let aborted = false
  const originalFetch = global.fetch
  global.fetch = (url, opts) => new Promise((resolve, reject) => {
    if (opts && opts.signal) {
      opts.signal.addEventListener('abort', () => {
        aborted = true
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      })
    }
  })

  const proc = new EnhancedTextProcessor('http://127.0.0.1:6006/v3', () => {}, () => {}, () => {}, {})
  proc._synthTimeoutMs = 300

  const t0 = Date.now()
  const result = await proc.convertTextToSpeech('hello there, this is a test line', 'neutral')
  const elapsed = Date.now() - t0

  check('超时后返回 null', result === null, 'got=' + String(result))
  check('确实走了 abort 路径', aborted === true)
  check('在 300ms 后很快返回（<2s）', elapsed < 2000, 'elapsed=' + elapsed + 'ms')

  console.log('[2] 正常 fetch：必须原样返回 blob')
  global.fetch = async () => ({ ok: true, blob: async () => ({ size: 1234 }) })
  const proc2 = new EnhancedTextProcessor('http://127.0.0.1:6006/v3', () => {}, () => {}, () => {}, {})
  proc2._synthTimeoutMs = 300
  const blob = await proc2.convertTextToSpeech('hi', 'neutral')
  check('正常路径返回 blob', blob && blob.size === 1234, JSON.stringify(blob))

  global.fetch = originalFetch
  console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error('测试自身异常:', e); process.exit(2) })
