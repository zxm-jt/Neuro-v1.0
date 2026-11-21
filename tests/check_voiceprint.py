# -*- coding: utf-8 -*-
"""tests/check_voiceprint.py —— 声纹能不能区分"user 的男声"和"她的女声回声"。"""
import importlib.util
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))
spec = importlib.util.spec_from_file_location("vp", os.path.join(ROOT, "backend", "voiceprint.py"))
vp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vp)

PASS = FAIL = 0


def ck(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}  {detail}")


SR = 16000


def voice(f0, dur=2.0, seed=1, amp=0.12, wobble=6.0):

    rng = np.random.default_rng(seed)
    t = np.arange(int(SR * dur)) / SR
    f = f0 + wobble * np.sin(2 * np.pi * 3.1 * t + rng.random())
    ph = 2 * np.pi * np.cumsum(f) / SR
    x = (np.sin(ph) + 0.45 * np.sin(2 * ph) + 0.22 * np.sin(3 * ph)
         + 0.10 * np.sin(4 * ph)) / 1.8
    x = x * amp + rng.normal(0, 0.002, x.size)
    return x.astype(np.float32)


print("[1] 特征提取能拿到有意义的基频与频带")
f_male = vp.extract_features(voice(115, seed=1), SR)
f_female = vp.extract_features(voice(215, seed=2), SR)
ck("男声特征提取成功", f_male is not None)
ck("女声特征提取成功", f_female is not None)
if f_male and f_female:
    ck("男声基频落在 90~160Hz", 90 <= f_male["f0_median"] <= 160, f_male["f0_median"])
    ck("女声基频落在 180~280Hz", 180 <= f_female["f0_median"] <= 280, f_female["f0_median"])
    ck("基频能分开两人", f_male["f0_median"] < f_female["f0_median"] - 40)

print("\n[2] 同一说话人的两段录音 → 相似度高于跨说话人")
a1 = vp.extract_features(voice(115, seed=11), SR)
a2 = vp.extract_features(voice(118, seed=12), SR)
b1 = vp.extract_features(voice(215, seed=21), SR)
sim_same = vp.similarity(a1, a2)
sim_cross = vp.similarity(a1, b1)
ck("同人相似度 > 跨人相似度", sim_same > sim_cross, f"同人 {sim_same:.3f} vs 跨人 {sim_cross:.3f}")
ck("同人判为同一人（阈值 0.70）", vp.is_same_speaker(a1, a2), f"{sim_same:.3f}")
ck("跨人不判为同一人", not vp.is_same_speaker(a1, b1), f"{sim_cross:.3f}")

print("\n[3] 你的声音说得轻/带情绪（基频飘）时仍能认出")
quiet = vp.extract_features(voice(105, dur=2.0, seed=31, amp=0.05, wobble=25.0), SR)
ck("轻声段特征仍可提取", quiet is not None)
if quiet:
    ck("轻声段与注册样本相似度仍达标", vp.similarity(quiet, a1) >= 0.70,
       f"{vp.similarity(quiet, a1):.3f}")

print("\n[4] WAV 字节 → PCM 解码（前端注册走这条路）")
import struct
pcm = voice(115, dur=1.0, seed=41)
raw = (np.clip(pcm, -1, 1) * 32767).astype("<i2").tobytes()
wav = (b"RIFF" + struct.pack("<I", 36 + len(raw)) + b"WAVEfmt "
       + struct.pack("<IHHIIHH", 16, 1, 1, SR, SR * 2, 2, 16)
       + b"data" + struct.pack("<I", len(raw)) + raw)
dec, sr2 = vp.wav_bytes_to_pcm(wav)
ck("WAV 解码成功", dec is not None and dec.size > 0)
ck("采样率正确", sr2 == SR, sr2)
if dec is not None:
    ck("解码后特征与原始一致", abs(vp.extract_features(dec, sr2)["f0_median"]
                                - vp.extract_features(pcm, SR)["f0_median"]) < 6)

print(f"\n结果：{PASS} PASS / {FAIL} FAIL")
sys.exit(0 if FAIL == 0 else 1)
