# -*- coding: utf-8 -*-
import io
import math
import time

import numpy as np

F0_MIN_HZ = 70.0
F0_MAX_HZ = 320.0


def _estimate_f0(x, sr=16000, fmin=F0_MIN_HZ, fmax=F0_MAX_HZ):
    x = np.asarray(x, dtype=np.float64).reshape(-1)
    n = x.size
    if n < 256:
        return 0.0
    x = x - x.mean()
    rms = float(np.sqrt(np.mean(x * x)))
    if rms < 0.002:
        return 0.0
    fft_size = 1
    while fft_size < 2 * n:
        fft_size <<= 1
    F = np.fft.rfft(x, fft_size)
    ac = np.fft.irfft(F * np.conj(F), fft_size)[:n]
    if ac.size == 0 or ac[0] <= 0:
        return 0.0
    ac = ac / ac[0]
    lag_min = max(2, int(sr / fmax))
    lag_max = min(n - 2, int(sr / fmin))
    if lag_max <= lag_min:
        return 0.0
    seg = ac[lag_min:lag_max]
    if seg.size == 0:
        return 0.0
    idx = int(np.argmax(seg)) + lag_min
    if ac[idx] < 0.30:
        return 0.0
    peak = float(ac[idx])
    j = idx
    while j - 1 >= lag_min and ac[j - 1] >= peak * 0.85:
        j -= 1
    idx = j
    f0 = sr / float(idx)
    return f0 if fmin <= f0 <= fmax else 0.0


def _band_ratios(x, sr=16000):

    n = x.size
    if n < 512:
        return (0.0, 0.0, 0.0)
    win = np.hanning(n)
    mag = np.abs(np.fft.rfft(x * win))
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    total = float(mag.sum()) or 1.0
    def frac(lo, hi):
        m = (freqs >= lo) & (freqs < hi)
        return float(mag[m].sum()) / total
    return (frac(0, 500), frac(500, 2000), frac(2000, 8000))


def extract_features(pcm, sr=16000):

    x = np.asarray(pcm, dtype=np.float64).reshape(-1)
    if x.size < 320:
        return None
    if np.max(np.abs(x)) > 1.5:
        x = x / 32768.0
    x = x - x.mean()
    rms = float(np.sqrt(np.mean(x * x)))
    if rms < 0.002:
        return None
    win_len = int(sr * 0.04)
    hop = int(sr * 0.02)
    f0s = []
    for st in range(0, max(1, x.size - win_len), hop):
        f = _estimate_f0(x[st:st + win_len], sr)
        if f > 0:
            f0s.append(f)
    f0_med = float(np.median(f0s)) if f0s else 0.0
    f0_std = float(np.std(f0s)) if len(f0s) > 1 else 0.0
    b0, b1, b2 = _band_ratios(x, sr)
    n = x.size
    win = np.hanning(n)
    mag = np.abs(np.fft.rfft(x * win))
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    tot = float(mag.sum()) or 1.0
    centroid = float((mag * freqs).sum() / tot)
    csum = np.cumsum(mag) / tot
    idx85 = int(np.searchsorted(csum, 0.85))
    idx85 = min(idx85, freqs.size - 1)
    rolloff = float(freqs[idx85])
    return {
        "f0_median": round(f0_med, 2),
        "f0_std": round(f0_std, 2),
        "centroid": round(centroid, 1),
        "rolloff85": round(rolloff, 1),
        "band_lo": round(b0, 4),
        "band_mid": round(b1, 4),
        "band_hi": round(b2, 4),
        "rms": round(rms, 4),
        "dur_s": round(x.size / float(sr), 2),
    }


def similarity(feat_a, feat_b):

    if not feat_a or not feat_b:
        return 0.0
    diffs = []
    weights = []
    fa, fb = float(feat_a.get("f0_median") or 0), float(feat_b.get("f0_median") or 0)
    if fa > 0 and fb > 0:
        diffs.append(min(1.0, abs(math.log2(fa / fb)) / 0.6))
        weights.append(8.0)
    for k, scale in (("centroid", 1200.0), ("rolloff85", 2500.0),
                      ("band_lo", 0.25), ("band_mid", 0.30), ("band_hi", 0.25)):
        diffs.append(min(1.0, abs(float(feat_a.get(k) or 0) - float(feat_b.get(k) or 0)) / scale))
        weights.append(1.0)
    if not diffs:
        return 0.0
    d = sum(w * x for w, x in zip(weights, diffs)) / float(sum(weights))
    return max(0.0, 1.0 - d)


def is_same_speaker(feat_a, feat_b, threshold=0.70):

    return similarity(feat_a, feat_b) >= threshold


def wav_bytes_to_pcm(data):

    if not data or len(data) < 44:
        return None, 0
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return None, 0
    pos = 12
    sr = 16000
    pcm = None
    while pos + 8 <= len(data):
        cid = data[pos:pos + 4]
        csize = int.from_bytes(data[pos + 4:pos + 8], "little")
        body = data[pos + 8:pos + 8 + csize]
        if cid == b"fmt ":
            if len(body) >= 16:
                sr = int.from_bytes(body[4:8], "little")
        elif cid == b"data":
            if len(body) >= 2:
                arr = np.frombuffer(body[:len(body) // 2 * 2], dtype="<i2")
                pcm = arr.astype(np.float32) / 32768.0
        pos += 8 + csize + (csize & 1)
    return pcm, sr


_HER_PROFILE = {"features": None, "ts": 0.0, "sample_rate": 16000}


def decode_audio_bytes(data):

    if not data or len(data) < 64:
        return None, 0
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        pcm, sr = wav_bytes_to_pcm(data)
        if pcm is not None and sr:
            return pcm, sr
    try:
        import io as _io
        import miniaudio
        dec = miniaudio.decode(_io.BytesIO(data),
                               output_format=miniaudio.SampleFormat.SIGNED16,
                               nchannels=1)
        arr = np.frombuffer(bytes(dec.samples), dtype="<i2")
        return (arr.astype(np.float32) / 32768.0), dec.sample_rate
    except Exception:
        pass
    try:
        import io as _io
        import av
        with av.open(_io.BytesIO(data)) as container:
            st = container.streams.audio[0]
            res = av.AudioResampler(format="s16", layout="mono", rate=16000)
            chunks = []
            for frame in container.decode(st):
                for out in res.resample(frame):
                    chunks.append(out.to_ndarray().reshape(-1))
            if chunks:
                arr = np.concatenate(chunks)
                return (arr.astype(np.float32) / 32768.0), 16000
    except Exception:
        pass
    return None, 0


def register_her_voice(audio_bytes):

    global _HER_PROFILE
    pcm, sr = decode_audio_bytes(audio_bytes)
    if pcm is None or pcm.size < sr * 0.3:
        return False, None
    feat = extract_features(pcm, sr)
    if not feat:
        return False, None
    _HER_PROFILE = {"features": feat, "ts": time.time(), "sample_rate": sr}
    return True, feat


def get_her_profile():

    return _HER_PROFILE.get("features")


def is_her_voice(feat, threshold=0.72, max_age_s=600.0):

    her = _HER_PROFILE.get("features")
    if not her or not feat:
        return False, "无她的声纹可比"
    if time.time() - float(_HER_PROFILE.get("ts") or 0) > max_age_s:
        return False, "她的声纹已过期"
    sim = similarity(feat, her)
    return (sim >= threshold), f"相似度 {sim:.2f}（阈值 {threshold:.2f}）"


def similar_to_her(feat, threshold=0.72):

    her = _HER_PROFILE.get("features")
    if not her or not feat:
        return 0.0
    return similarity(feat, her)
