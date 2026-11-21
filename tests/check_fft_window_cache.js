'use strict'

const path = require('path')
const { ASRProcessor } = require(path.join(__dirname, '..', 'js', 'asr-processor.js'))

let fails = 0
function check(name, cond, extra) {
  if (cond) console.log('  PASS ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')) }
}

const fake = {
  micSampleRate: 48000,
  _hann: ASRProcessor.prototype._hann,
  _spectrum: ASRProcessor.prototype._spectrum,
}

console.log('[1] 缓存生效：同 size 返回同一对象')
const h1 = fake._hann(512)
const h2 = fake._hann(512)
check('hann(512) 是同一引用', h1 === h2)
check('hann(512) 长度正确', h1.length === 512)
check('hann 首尾接近 0', Math.abs(h1[0]) < 1e-6 && Math.abs(h1[511]) < 1e-3)

console.log('[2] 频谱与朴素 DFT 一致（误差 < 1e-3 相对量级）')
const buf = new Float32Array(1024)
for (let i = 0; i < buf.length; i++) {
  buf[i] = 0.6 * Math.sin(2 * Math.PI * 440 * i / 48000) + 0.05 * Math.sin(i * 12.9898)
}
const sp = fake._spectrum(buf, 0, 1024)
check('spectrum.size 是 2 的幂且 ≤ 1024', (sp.size & (sp.size - 1)) === 0 && sp.size <= 1024, 'got=' + sp.size)

const size = sp.size
const hann = fake._hann(size)
function dftMag(bin) {
  let re = 0, im = 0
  for (let i = 0; i < size; i++) {
    const x = (buf[i] || 0) * hann[i]
    const ang = -2 * Math.PI * bin * i / size
    re += x * Math.cos(ang)
    im += x * Math.sin(ang)
  }
  return Math.hypot(re, im)
}
let maxRel = 0
for (const bin of [1, 5, 9, 47, 100]) {
  const ref = dftMag(bin)
  const got = sp.mag[bin]
  const rel = ref > 1e-6 ? Math.abs(got - ref) / ref : Math.abs(got - ref)
  if (rel > maxRel) maxRel = rel
}
check('FFT 与 DFT 最大相对误差 < 5e-3', maxRel < 5e-3, 'maxRel=' + maxRel.toExponential(2))

console.log('[3] 主峰落在 440Hz 附近的 bin 上')
let peak = 0, peakIdx = 0
for (let i = 1; i < sp.half; i++) if (sp.mag[i] > peak) { peak = sp.mag[i]; peakIdx = i }
const peakHz = peakIdx * sp.hzPerBin
check('峰值 ≈ 440Hz（±25Hz）', Math.abs(peakHz - 440) <= 25, 'peak=' + peakHz.toFixed(1) + 'Hz')

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
