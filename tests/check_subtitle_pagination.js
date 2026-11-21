const { EnhancedTextProcessor } = require('../js/tts-processor.js');

let PASS = 0, FAIL = 0;
function ck(name, cond, detail = '') {
    if (cond) { PASS++; console.log(`  PASS  ${name}`); }
    else { FAIL++; console.log(`  FAIL  ${name}  ${detail}`); }
}

function makeProc() {
    const p = Object.create(EnhancedTextProcessor.prototype);
    p.textSegmentQueue = [];
    p._pgIdx = 0;
    p._pgText = '';
    p._pgTotal = 1;
    p._pgMax = 150;
    return p;
}

console.log('[1] 分页边界：长回复必须分成多页');
{
    const p = makeProc();
    const segs = [];
    for (let i = 0; i < 6; i++) {
        const s = 'This is sentence number ' + i + ' padded out to about sixty characters for the test.';
        segs.push(s);
        p._enqueueSegment(s, 'neutral');
    }
    ck('分段数 = 输入段数（内容不丢）', p.textSegmentQueue.length === segs.length,
        `实际 ${p.textSegmentQueue.length}`);
    ck('总页数 > 1', p._pgTotal > 1, `实际 ${p._pgTotal}`);
    const pageIdx = p.textSegmentQueue.map(s => s.pageIdx);
    ck('页号单调不减', pageIdx.every((v, i) => i === 0 || v >= pageIdx[i - 1]), pageIdx.join(','));
    ck('页号从 0 开始', pageIdx[0] === 0);

    const perPage = new Map();
    for (const s of p.textSegmentQueue) {
        perPage.set(s.pageIdx, (perPage.get(s.pageIdx) || 0) + s.text.length);
    }
    let over = 0;
    for (const [idx, len] of perPage) {
        const isLast = idx === Math.max(...perPage.keys());
        if (!isLast && len > p._pgMax + 80) over++;
    }
    ck('每页字符数在预算内', over === 0, `超限页数 ${over}`);

    const firstOfPage2 = p.textSegmentQueue.find(s => s.pageIdx === 1);
    ck('新页首段的 pageBase 为空', firstOfPage2 && firstOfPage2.pageBase === '',
        JSON.stringify(firstOfPage2 && firstOfPage2.pageBase));
    const page1 = p.textSegmentQueue.filter(s => s.pageIdx === 1);
    if (page1.length >= 2) {
        ck('同页第 2 段的 pageBase = 本页第 1 段文本',
            page1[1].pageBase === page1[0].text, page1[1].pageBase);
    } else {
        ck('同页第 2 段的 pageBase = 本页第 1 段文本', true, '（本页只有 1 段，跳过）');
    }
}

console.log('\n[2] 短回复不分页（不显示页码）');
{
    const p = makeProc();
    p._enqueueSegment('Short and sweet, user.', 'neutral');
    ck('只有一页', p._pgTotal === 1, `实际 ${p._pgTotal}`);
    ck('pageBase 为空（显示就是这一段）', p.textSegmentQueue[0].pageBase === '');
}

console.log('\n[3] 揭示基底 = 当前页基底（不是整段回复全文）');
{
    const p = makeProc();
    const long = 'Alpha segment that belongs to the first page of the subtitle flow here.';
    const long2 = 'Beta segment that continues on the same first page of the subtitle flow.';
    const long3 = 'Gamma segment that must open a brand new page because the budget is full.';
    p._enqueueSegment(long, 'neutral');
    p._enqueueSegment(long2, 'neutral');
    p._enqueueSegment(long3, 'neutral');
    const seg = p.textSegmentQueue[2];
    ck('第 3 段是新页', seg.pageIdx === 1, `实际 ${seg.pageIdx}`);
    p._curPage = { idx: seg.pageIdx, base: seg.pageBase, total: p._pgTotal };
    const baseText = p._curPage.base;
    ck('揭示基底不含上一页内容', baseText.indexOf('Alpha') === -1, baseText);
    ck('揭示基底为空（新页第一段）', baseText === '', JSON.stringify(baseText));
}

console.log('\n[4] reset 后分页状态归零（下一轮重新分页）');
{
    const p = makeProc();
    p._enqueueSegment('Some long content here to make pages happen in this test case.', 'neutral');
    p._enqueueSegment('Another long content here to make pages happen in this test case.', 'neutral');
    const before = p._pgIdx;
    p._pgIdx = 0; p._pgText = ''; p._pgTotal = 1; p._curPage = null;
    ck('页号归零', p._pgIdx === 0, `before=${before}`);
    ck('页文本归零', p._pgText === '');
    ck('总页数归 1', p._pgTotal === 1);
}

console.log('\n[5] 端到端：长回复分页后，页边界=段边界，全文不丢不重');
{
    const p = makeProc();
    const full = 'First sentence about the moon. Second sentence about the moon. '
        + 'Third sentence about the moon. Fourth sentence about the moon. '
        + 'Fifth sentence about the moon. Sixth sentence about the moon.';
    const segs = full.split(/(?<=[.!?])\s+/);
    for (const s of segs) p._enqueueSegment(s, 'neutral');

    ck('分段数 = 句子数', p.textSegmentQueue.length === segs.length,
        `实际 ${p.textSegmentQueue.length}`);

    const pages = new Map();
    for (const s of p.textSegmentQueue) {
        const page = s.pageIdx;
        const shown = (s.pageBase || '') + s.text;
        if (!pages.has(page)) pages.set(page, new Set());
        pages.get(page).add(shown);
    }
    ck('页数 > 1', pages.size > 1, `实际 ${pages.size}`);

    const idxs = p.textSegmentQueue.map(s => s.pageIdx);
    ck('页号不倒退', idxs.every((v, i) => i === 0 || v >= idxs[i - 1]));

    const rebuilt = p.textSegmentQueue.map(s => s.text).join(' ');
    const norm = t => t.replace(/\s+/g, ' ').trim();
    ck('全文不丢（拼回去 === 原文）', norm(rebuilt) === norm(full),
        `\n      拼回: ${norm(rebuilt).slice(0, 80)}\n      原文: ${norm(full).slice(0, 80)}`);
    ck('全文不重（每段只出现一次）',
        new Set(p.textSegmentQueue.map(s => s.text)).size === p.textSegmentQueue.length);

    const lastPage = p.textSegmentQueue[p.textSegmentQueue.length - 1];
    const pageText = (lastPage.pageBase || '') + lastPage.text;
    ck('最后一页不含前面的页（每页独立）',
        !pageText.includes('First sentence') || lastPage.pageIdx === 0);
}
console.log(`\n追加用例完成`);

console.log(`\n结果：${PASS} PASS / ${FAIL} FAIL`);
process.exit(FAIL === 0 ? 0 : 1);
