const path = require('path');
const { ASRProcessor } = require(path.join(__dirname, '..', 'js', 'asr-processor.js'));

let pass = 0, fail = 0;
function ck(name, ok, extra = '') {
    if (ok) { pass++; console.log('  PASS ', name, extra); }
    else { fail++; console.log('  FAIL ', name, extra); }
}
const frame = (n) => Buffer.from([n]);

function make() {
    const p = new ASRProcessor(null, null, {
        asr: { stream_url: 'ws://127.0.0.1:6006/v1/asr_stream' },
    });
    const sent = [];
    p._streamOnline = () => true;
    const ws = {
        readyState: 1,
        bufferedAmount: 0,
        send: (b) => sent.push(Buffer.from(b)[0]),
        close: () => {},
    };
    p._ws = ws;
    return { p, sent, ws };
}

console.log('[1] 正常发送');
{
    const { p, sent } = make();
    p._streamSendAudio(frame(1));
    p._streamSendAudio(frame(2));
    p._streamSendAudio(frame(3));
    ck('3 帧按序送出', sent.join(',') === '1,2,3', sent.join(','));
    p.closeStream();
}

console.log('[2] 背压时暂存、恢复后补发');
{
    const { p, sent, ws } = make();
    ws.bufferedAmount = 600 * 1024;
    p._streamSendAudio(frame(1));
    p._streamSendAudio(frame(2));
    p._streamSendAudio(frame(3));
    ck('背压期间不丢帧（暂存 3 帧）',
        sent.length === 0 && p._deferredAudio.length === 3,
        `sent=${sent.length} deferred=${p._deferredAudio.length}`);
    ws.bufferedAmount = 0;
    p._streamSendAudio(frame(4));
    ck('恢复后按原顺序补发 + 当前帧', sent.join(',') === '1,2,3,4', sent.join(','));
    p.closeStream();
}

console.log('[3] 补发途中再次堵塞');
{
    const { p, sent, ws } = make();
    ws.bufferedAmount = 600 * 1024;
    for (let i = 1; i <= 3; i++) p._streamSendAudio(frame(i));
    ws.bufferedAmount = 0;
    const realSend = ws.send;
    let hits = 0;
    ws.send = (b) => { sent.push(Buffer.from(b)[0]); if (++hits === 1) ws.bufferedAmount = 600 * 1024; };
    p._streamSendAudio(frame(4));
    ck('剩余帧与当前帧一起留待下轮（不丢）',
        p._deferredAudio.length === 3,
        `sent=${sent.join(',')} deferred=${p._deferredAudio.length}`);
    ws.bufferedAmount = 0;
    ws.send = realSend;
    p._streamSendAudio(frame(5));
    ck('最终顺序完整 1,2,3,4,5', sent.join(',') === '1,2,3,4,5', sent.join(','));
    p.closeStream();
}

console.log('[4] 暂存上限');
{
    const { p, ws } = make();
    ws.bufferedAmount = 600 * 1024;
    const big = Buffer.alloc(1024 * 1024, 7);
    for (let i = 0; i < 4; i++) p._streamSendAudio(big);
    const total = p._deferredAudio.reduce((a, b) => a + b.byteLength, 0);
    ck('暂存总量不超过 2MB 上限', total <= 2 * 1024 * 1024, `total=${total}`);
    ck('超上限时仍有帧保留（保住尾句）', p._deferredAudio.length >= 1,
        `deferred=${p._deferredAudio.length}`);
    p.closeStream();
}

console.log('[5] 断线清理');
{
    const { p, ws } = make();
    ws.bufferedAmount = 600 * 1024;
    p._streamSendAudio(frame(1));
    p.closeStream();
    ck('断线清掉待补发音频', p._deferredAudio.length === 0 && p._deferredAudioSize === 0,
        `deferred=${p._deferredAudio.length}`);
}

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
