// ============================================================================
// check_room_no_history.js -- "对话框不显示上次聊天内容" 回归
//
// 用户要求（2026-11-21）：
//   ① 打开聊天房，不能看到上一次会话的对话；
//   ② 上次的对话也不能被当成上下文注入本次（后端 _conv_history / chat_stream）。
//
// 做法：把 js/chatroom.js 里的 SESSION_MARK_RE / lastSessionMarkIndex /
// buildRoomChat 原样抽出来跑（不 require electron），再对后端源码做静态断言。
// 纯 Node，无依赖。
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'js', 'chatroom.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('  PASS ' + name); }
    else { fail++; console.log('  FAIL ' + name + (detail ? '  [' + detail + ']' : '')); }
}

// ---- 从源码里抽出纯函数（避免 require electron） ----
function grab(re, what) {
    const m = SRC.match(re);
    if (!m) throw new Error('抽不到 ' + what + '：chatroom.js 结构变了？');
    return m[0];
}
const code = [
    grab(/const SESSION_MARK_RE = [^\n]+/, 'SESSION_MARK_RE'),
    grab(/function lastSessionMarkIndex\(lines\) \{[\s\S]*?\n\}/, 'lastSessionMarkIndex'),
    grab(/function buildRoomChat\(lines\) \{[\s\S]*?\n\}/, 'buildRoomChat'),
].join('\n');

const buildRoomChat = new Function(code + '\nreturn buildRoomChat;')();

console.log('[1] 上一次会话的对话不进聊天房');
const lines = [
    '[21:00:01] session: ===== 新会话开始 =====',
    '[21:00:05] user: 上次说过的话 AAA',
    '[21:00:09] neuro: 上次的回复 BBB',
    '[21:30:00] session: ===== 新会话开始 =====',
    '[21:30:10] user: 这次说的话 CCC',
    '[21:30:15] neuro: 这次的回复 DDD',
];
const chat = buildRoomChat(lines);
check('只保留本次会话的行', chat.length === 2 && /CCC/.test(chat[0]) && /DDD/.test(chat[1]),
    JSON.stringify(chat));
check('绝不出现上次会话的正文', !chat.some((l) => /AAA|BBB/.test(l)), JSON.stringify(chat));
check('不再有 [上次会话] 前缀', !chat.some((l) => l.includes('上次会话')), JSON.stringify(chat));
check('会话标记本身不渲染', !chat.some((l) => /session:/.test(l)));

console.log('[2] 没有会话标记（后端还没起来 / 老日志）→ 宁可空白也不回灌');
check('无标记返回空数组', Array.isArray(buildRoomChat(['[21:00:05] user: 老内容 X']))
    && buildRoomChat(['[21:00:05] user: 老内容 X']).length === 0);
check('空文件返回空数组', buildRoomChat([]).length === 0);
check('只有一条标记返回空数组',
    buildRoomChat(['[21:30:00] session: ===== 新会话开始 =====']).length === 0);

console.log('[3] 连续标记（后端连重启）不吞掉本次对话');
const dup = [
    '[21:00:00] session: ===== 新会话开始 =====',
    '[21:29:00] session: ===== 新会话开始 =====',
    '[21:30:10] user: 新的一句 EEE',
];
const dupChat = buildRoomChat(dup);
check('仍能看到标记后的内容', dupChat.length === 1 && /EEE/.test(dupChat[0]), JSON.stringify(dupChat));

console.log('[4] 后端侧：启动即清空上次对话 + 默认不补发历史');
const NS = fs.readFileSync(path.join(ROOT, 'backend', 'neuro_server.py'), 'utf8');
check('启动时归档旧 chat_log（os.replace 到 logs/chat_log.prev.txt）',
    /os\.replace\(_CHAT_LOG,\s*_prev_log\)/.test(NS));
check('启动时把 chat_log 重写成只有本次标记',
    /with open\(_CHAT_LOG, "w", encoding="utf-8"\) as f:\s*\n\s*f\.write\(line \+ "\\n"\)/.test(NS));
check('启动时清零 _conv_history', /_conv_history\.clear\(\)/.test(NS));
check('/v1/chat_stream 默认 tail=0', /async def chat_stream\(tail: int = 0\)/.test(NS));
check('没有把 chat_log 塞进 messages 的代码（只用于落盘/推送）',
    !/messages[\s\S]{0,80}_read_chat_tail/.test(NS));

console.log('\n' + (fail ? (fail + ' FAILED') : 'ALL PASS') + '  (' + pass + ' checks)');
process.exit(fail ? 1 : 0);
