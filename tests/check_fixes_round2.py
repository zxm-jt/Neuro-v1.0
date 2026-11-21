# -*- coding: utf-8 -*-
"""验证本轮三项修复："""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'backend'))

import neuro_server as ns

fix = ns._fix_missing_spaces

passed = failed = 0


def ck(name, cond, extra=''):
    global passed, failed
    if cond:
        passed += 1
        print(f'  PASS  {name}')
    else:
        failed += 1
        print(f'  FAIL  {name}  {extra}')


print('\n=== 1. 词间粘连修复（真实样本）===')
real_glued = [
    ('dandclear', 'and clear'),
    ('twoscoops', 'two scoops'),
    ('illonthetable', 'ill on the table'),
    ('ecidedtosayhi', 'decided to say hi'),
    ('mysterysolved', 'mystery solved'),
    ('craftlauncher', 'craft launcher'),
    ('abrowsertab', 'a browser tab'),
    ('isthatabribe', 'is that a bribe'),
    ('arewebreaking', 'are we breaking'),
    ('aveplenty', 'have plenty'),
]
for glued, want in real_glued:
    got = fix(f'Some text {glued} more.')
    ck(f'"{glued}" → 含 "{want}"', want in got, f'got={got!r}')

print('\n--- 【2026-11-05 契约变更】缩写原样保留（不改写用户原话）---')
for src in ["That's me", "I can't eat", "it's working", "don't know",
            "you're right", "I'm not sure", "let's go", "we're here"]:
    got = fix(src)
    ck(f'{src!r} 原样保留（不展开缩写）', got == src, f'got={got!r}')

import subprocess as _sp
_SCRIPT = (
    "import sys; sys.path.insert(0, %r);" % os.path.join(ROOT, 'backend') +
    "import neuro_server as ns;"
    "print(ns._fix_missing_spaces(\"it's fine and I can't go\"))"
)
_r = _sp.run([sys.executable, '-c', _SCRIPT], capture_output=True, text=True,
             env=dict(os.environ, NEURO_ASR_KEEP_CONTRACTIONS='0'), timeout=180)
ck('开关=0 时可恢复展开（可回溯）',
   'it is fine' in _r.stdout and 'can not go' in _r.stdout,
   f'stdout={_r.stdout.strip()!r} stderr={_r.stderr.strip()[-160:]!r}')

print('\n--- 【关键】正常单词绝不能被改坏 ---')
# 这些是日志里出现频率最高的"长串"，但它们是【真实单词】，不能切
must_keep = [
    'necessarily', 'character', 'Emotions', 'adventure', 'domination',
    'plotting', 'Timehelmet', 'NPCR',
]
for w in must_keep:
    got = fix(f'I saw {w} yesterday.')
    ck(f'保留完整单词 "{w}"', w in got, f'got={got!r}')

print('\n--- 已有正确空格的不应被改 ---')
for s in ['the game is good', 'you are right', 'thank you', 'are we breaking']:
    got = fix(s)
    ck(f'"{s}" 不变', got == s, f'got={got!r}')

print('\n--- 【2026-11-05 加固】中文/日韩文旁边不误伤 ---')
for s in ['我今天很happy', '三个alauncher', 'テストalauncher', '谢谢thankyou']:
    got = fix(s)
    ck(f'{s!r} 原样', got == s, f'got={got!r}')

print('\n--- 空/None 不崩 ---')
ck('None 输入安全', fix(None) is None)
ck('空串安全', fix('') == '')

print('\n=== 2. 开录总闸门（源码级断言）===')
with open(os.path.join(ROOT, 'js', 'asr-processor.js'), encoding='utf-8') as f:
    SRC = f.read()

# 必须在 startRecording() 入口处有两个闸门
m = re.search(r'startRecording\(\)\s*\{(.{0,1200})', SRC, re.S)
ck('startRecording() 存在', m is not None)
if m:
    head = m.group(1)
    ck('入口拦流式在线', 'this._streamOnline()' in head)
    ck('入口拦她说话（isProcessingAudio）', 'this.isProcessingAudio' in head)
    # 两个闸门的 return 必须在 isRecording=true 之前
    idx_gate = head.find('_streamOnline()')
    idx_set = head.find('this.isRecording = true')
    ck('闸门在置 isRecording 之前生效', 0 < idx_gate < idx_set,
       f'gate@{idx_gate} set@{idx_set}')

# 电平兜底那条路径也要短路
ck('电平兜底开录已加流式短路', '电平兜底开录' in SRC and
   re.search(r'_streamOnline\(\)\)\s*\{\s*//\s*流式在跑 → 不开录', SRC) is not None)

print('\n=== 3. 情绪判定收紧 + 语速压缩 ===')
tp = os.path.join(ROOT, 'js', 'tts-processor.js')
with open(tp, encoding='utf-8') as f:
    TSRC = f.read()

ck('不再有 rate +30%', 'rate: "+30%"' not in TSRC)
ck('不再有 rate +38%', 'rate: "+38%"' not in TSRC)
ck('不再有 rate +28%', 'rate: "+28%"' not in TSRC)

# 加速幅度上限收紧到 +18%
rates = re.findall(r'rate:\s*"([+-]\d+)%"', TSRC)
if rates:
    pos = max(int(r) for r in rates)
    neg = min(int(r) for r in rates)
    ck(f'最快加速 <= +18%（实测 +{pos}%）', pos <= 18, f'rates={rates}')
    ck(f'最慢减速 >= -12%（实测 {neg}%）', neg >= -12, f'rates={rates}')

import subprocess
NODE = os.path.join(ROOT, 'node', 'node.exe')


def classify(text):

    script = f'''
const path = require("path");
const {{ EnhancedTextProcessor }} = require(path.join("{ROOT.replace(chr(92), '/')}", "js", "tts-processor.js"));
const t = process.argv[1];
console.log(EnhancedTextProcessor.classifyEmotion(t));
'''
    r = subprocess.run([NODE, '-e', script, text],
                       capture_output=True, text=True, timeout=60)
    return r.stdout.strip()


print('\n--- 【关键】不该误判成情绪的普通句子 ---')
should_be_neutral = [
    ('Heh, did you expect anything less?', '闲聊，不该加速'),
    ('Yeah, that works.', '裸 yeah 以前会判 excited'),
    ('I love this design.', '裸 love 以前会判 happy'),
    ('Use shell to list files.', 'shell 含 hell，以前会判 angry'),
    ('Hello there, how are you?', 'hello 含 hell'),
    ('The crystal is clear.', 'crystal 含 cry，以前会判 sad'),
    ('I shall send you the synthesis notes.', 'shall 含 hell'),
    ('You worry about nothing.', 'worry 以前会判 worried'),
]
for text, why in should_be_neutral:
    got = classify(text)
    ck(f'neutral: {why}', got == 'neutral', f'got={got!r} text={text!r}')

print('\n--- 【关键】真正的情绪仍要认出来（不能收得太紧）---')
should_detect = [
    ("Shut up already!", 'angry'),
    ("Stop it right now!", 'angry'),
    ('Yay! This is great!', 'happy'),
    ("I'm so happy about this!", 'happy'),
    ("I feel lonely tonight.", 'sad'),
    ("I'm worried about that.", 'worried'),
    ("OMG what the heck!", 'surprised'),
    ("I'm so excited, let's go!", 'excited'),
    ('讨厌你！', 'angry'),
    ('太好了好开心', 'happy'),
    ('好难过，呜', 'sad'),
    ('好害怕怎么办', 'worried'),
    ('好激动！', 'excited'),
]
for text, want in should_detect:
    got = classify(text)
    ck(f'{want}: {text[:32]!r}', got == want, f'got={got!r} want={want!r}')

print(f'\n===== {passed} passed, {failed} failed =====')
sys.exit(0 if failed == 0 else 1)
