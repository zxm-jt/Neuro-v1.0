const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', 'js', 'asr-processor.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-asr-'));
const COPY = path.join(TMP, 'asr-processor.js');
fs.copyFileSync(SRC, COPY);
const { ASRProcessor } = require(COPY);

let pass = 0, fail = 0;
function ck(name, cond, extra) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

function makeProcessor() {
    const p = new ASRProcessor('', 'http://127.0.0.1:9999/v1/upload_audio', {});
    p.micSampleRate = 48000;
    p.ratio = 3;
    p._asrQueue = [];
    p.asrLocked = false;
    p._noiseFrozen = false;
    p._bargeInSegment = false;
    p.isProcessingAudio = false;
    p._recStartedAt = Date.now() - 6000;
    p._lastSpeakEndAt = 0;
    p._winLen = 15360;
    return p;
}

function fillRecording(p, seconds) {
    const n = Math.floor(p.micSampleRate * seconds);
    p.recordingBuf = new Array(n);
    for (let i = 0; i < n; i++) p.recordingBuf[i] = 0.2 * Math.sin(2 * Math.PI * 200 * i / 48000);
    p.isRecording = true;
}

(async () => {
    {
        const p = makeProcessor();
        fillRecording(p, 6.67);
        let calledWith = null;
        p._recognize = async function (slice) { calledWith = slice; };
        let thrown = null;
        try { await p.finishRecording(true); } catch (e) { thrown = e; }
        ck('finishRecording 不抛异常（ ReferenceError 回归 ）', thrown === null,
            thrown && (thrown.name + ': ' + thrown.message));
        ck('finishRecording 调用了 _recognize', calledWith !== null);
        ck('传给 _recognize 的录音长度正确', calledWith && calledWith.length === 320160,
            calledWith && calledWith.length);
        ck('调用后 recordingBuf 已清空', p.recordingBuf.length === 0);
        ck('噪声模板已解冻', p._noiseFrozen === false);
    }

    // ===== 2) 空片段：提前返回，不调 _recognize =====
    {
        const p = makeProcessor();
        p.recordingBuf = [];
        p.isRecording = true;
        let called = false;
        p._recognize = async function () { called = true; };
        await p.finishRecording(true);
        ck('空片段 → 不调 _recognize', called === false);
        ck('空片段 → 噪声模板仍解冻', p._noiseFrozen === false);
    }

    // ===== 3) 没在录音且非强制：直接返回 =====
    {
        const p = makeProcessor();
        p.isRecording = false;
        fillRecording(p, 1);
        p.isRecording = false;
        let called = false;
        p._recognize = async function () { called = true; };
        await p.finishRecording(false);
        ck('未录音 + 非强制 → 直接返回', called === false);
    }

    {
        const p = makeProcessor();
        p.asrLocked = true;
        p._onSubmitError(new Error('boom'));
        ck('_onSubmitError 不动 asrLocked（锁归 _recognize 管）', p.asrLocked === true);
    }

    {
        const p = makeProcessor();
        let n = 0;
        p.onAsrError = () => { n++; };
        p._notifyAsrError('a');
        p._notifyAsrError('b');
        ck('_notifyAsrError 30s 节流', n === 1, n);
    }

    {
        const bad = async function () {
            try { const slice = [1]; if (!slice.length) return; }
            finally { }
            return slice;
        };
        let err = null;
        try { await bad(); } catch (e) { err = e; }
        ck('对照：try 内 const 在外部引用确实抛 ReferenceError',
            err instanceof ReferenceError, err && err.name);
    }

    {
        const p = makeProcessor();
        p._isEchoSegment = () => false;
        p._pushToMergeBuffer = () => {};
        let inFlight = 0, maxInFlight = 0, fetches = 0;
        const realFetch = global.fetch;
        global.fetch = async () => {
            inFlight++; fetches++;
            if (inFlight > maxInFlight) maxInFlight = inFlight;
            await new Promise(r => setTimeout(r, 300));
            inFlight--;
            return { status: 200, json: async () => ({ status: 'error', text: '' }) };
        };
        try {
            fillRecording(p, 6.67);
            const f1 = p.finishRecording(true).catch(() => {});
            await wait(30);
            fillRecording(p, 6.0);
            const f2 = p.finishRecording(true).catch(() => {});
            await wait(30);
            ck('第二段在队列里等待（没有并发开扫）',
                p._asrQueue.length === 1 && inFlight === 1,
                `队列=${p._asrQueue.length} 在飞=${inFlight}`);
            await Promise.all([f1, f2]);
            await wait(600);
            ck('并发回归：任意时刻最多 1 个识别请求在飞', maxInFlight === 1, maxInFlight);
            ck('两段都被识别了（排队不丢话）', fetches === 2, fetches);
        } finally {
            global.fetch = realFetch;
        }
    }

    {
        const p = makeProcessor();
        p._isEchoSegment = () => false;
        p._pushToMergeBuffer = () => {};
        let inFlight = 0, maxInFlight = 0;
        const gates = [];
        const realFetch = global.fetch;
        global.fetch = async () => {
            inFlight++;
            if (inFlight > maxInFlight) maxInFlight = inFlight;
            await new Promise(r => gates.push(r));
            inFlight--;
            return { status: 200, json: async () => ({ status: 'error', text: '' }) };
        };
        try {
            fillRecording(p, 6.67);
            p.finishRecording(true).catch(() => {});
            await wait(30);
            fillRecording(p, 6.0);
            p.finishRecording(true).catch(() => {});
            await wait(30);
            ck('段2 入队', p._asrQueue.length === 1, p._asrQueue.length);

            gates[0]();
            await wait(30);
            ck('段1 完成后锁已释放', p.asrLocked === false);

            fillRecording(p, 6.0);
            p.finishRecording(true).catch(() => {});
            await wait(30);
            ck('段3 直接开扫（锁被它置起）', p.asrLocked === true && inFlight === 1,
                `锁=${p.asrLocked} 在飞=${inFlight}`);

            await wait(200);
            ck('防重入：没有并发识别', maxInFlight === 1, maxInFlight);
            ck('排队段被放回队首（未被并发启动）',
                p._asrQueue.length === 1, p._asrQueue.length);

            gates[1]();
            await wait(300);
            ck('段3 完成后排队段被接上（不丢话）', gates.length === 3, gates.length);
            ck('全程无并发', maxInFlight === 1, maxInFlight);
            if (gates[2]) gates[2]();
            await wait(100);
        } finally {
            global.fetch = realFetch;
        }
    }

    console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(fail > 0 ? 1 : 0);
})();
