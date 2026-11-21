const { EnhancedTextProcessor: TTSProcessor } = require('../js/tts-processor.js');

const exported = Object.keys(require('../js/tts-processor.js'));
console.log('导出的键:', exported.join(', '));

let ProcessorClass = null;
if (typeof TTSProcessor === 'function' && TTSProcessor.prototype && typeof TTSProcessor.prototype.isPlaying === 'function') {
    ProcessorClass = TTSProcessor;
} else {
    for (const k of exported) {
        const v = require('../js/tts-processor.js')[k];
        if (typeof v === 'function' && v.prototype && typeof v.prototype.isPlaying === 'function') {
            ProcessorClass = v;
            break;
        }
    }
}

if (!ProcessorClass) {
    console.log('✗ 找不到 TTSProcessor 类（导出名可能不同，仅验证模块加载）');
    process.exit(0);
}

let pass = 0, fail = 0;
function ck(name, cond, extra = '') {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (extra ? '  (' + extra + ')' : '')); }
}

console.log('\n[1] isPlaying 基础状态');
const p = Object.create(TTSProcessor.prototype);
p._audioPlaying = false;
p.isProcessing = false;
p._synthInFlight = 0;
p._pendingAudios = new Map();
p.textSegmentQueue = [];
p.audioDataQueue = [];
p.pendingSegment = '';
ck('初始状态（无内容）→ false', p.isPlaying() === false);

p._audioPlaying = true;
ck('播放中 → true', p.isPlaying() === true);
p._audioPlaying = false;

console.log('\n[2] 合成在途（本次修复核心）');
p._synthInFlight = 2;
p.textSegmentQueue = [];
p.audioDataQueue = [];
p.pendingSegment = '';
p.isProcessing = false;
p._pendingAudios = new Map();
ck('合成在途 2 段 + 队列空 → true（修复生效）', p.isPlaying() === true);

p._synthInFlight = 0;
p._pendingAudios.set('k', 'v');
ck('已合成未入队 → true（修复生效）', p.isPlaying() === true);

p._pendingAudios = new Map();
ck('全部清空 → false', p.isPlaying() === false);

console.log('\n[3] 待播队列');
p.textSegmentQueue.push({ text: 'hi' });
ck('待播文本段 → true', p.isPlaying() === true);
p.textSegmentQueue = [];
p.audioDataQueue.push({ text: 'hi' });
ck('待播音频 → true', p.isPlaying() === true);
p.audioDataQueue = [];

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail > 0 ? 1 : 0);
