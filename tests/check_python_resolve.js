const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEP_CHECK = ['-c', 'import fastapi, numpy'];
const TIMEOUT_MS = 20000;

function check(py, label) {
    if (!fs.existsSync(py)) {
        console.log(`  SKIP  ${label}: ${py} 不存在`);
        return null;
    }
    const r = spawnSync(py, DEP_CHECK, { timeout: TIMEOUT_MS, windowsHide: true });
    const ok = r.status === 0;
    const err = ok ? '' : (r.stderr || r.stdout || Buffer.alloc(0)).toString('utf8').split('\n')[0].slice(0, 90);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${ok ? '依赖自检通过' : '缺依赖 → ' + err}`);
    return ok;
}

let fail = 0;
console.log('=== Python 解析链前提验证 ===\n');

// 1) Store stub（Win10/11 默认在 PATH 上）必须被拒
const stub = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'python.exe');
if (fs.existsSync(stub)) {
    const ok = check(stub, 'Store stub（必须拒）');
    if (ok === true) { fail++; console.log('    ★ stub 竟然有依赖？那它就不是 stub，人工确认一下'); }
} else {
    console.log('  SKIP  本机没有 Store stub');
}

// 2) 本机 venv 必须过
const venv = 'C:\\Users\\<YOUR_USER>\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe';
const venvOk = check(venv, '本机 venv（必须过）');
if (venvOk === false) fail++;

for (const p of ['E:\\Neuro\\python\\python.exe', path.join(__dirname, '..', 'python', 'python.exe')]) {
    if (fs.existsSync(p)) {
        const ok = check(p, `盘内便携 python: ${p}`);
        if (ok === false) fail++;
    }
}

console.log(`\n结果：${fail === 0 ? 'ALL PASS' : fail + ' FAIL'}`);
process.exit(fail > 0 ? 1 : 0);
