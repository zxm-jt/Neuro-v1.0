import json
import os
import threading
import time

import numpy as np
from collections import deque

def _env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except Exception:
        return default


def _env_float(name, default):
    try:
        return float(os.environ.get(name, default))
    except Exception:
        return default


def _cfg_num(key, default):

    try:
        import json
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config.json")
        try:
            import secret_store
            cfg = secret_store.load_config(p)
        except Exception:
            with open(p, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        v = cfg.get("asr", {}).get(key)
        return type(default)(v) if v is not None else default
    except Exception:
        return default


_DIAG_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "logs", "backend_diag.log")


def _dprint(*args):

    try:
        line = "[" + time.strftime("%H:%M:%S") + "] " + " ".join(str(a) for a in args)
        with open(_DIAG_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


SR = 16000
FRAME = 512
SPEECH_THRESH = _env_float("NEURO_STREAM_THRESH", 0.85)
MIN_SPEECH_MS = _env_int("NEURO_STREAM_MIN_SPEECH_MS", 160)
END_SILENCE_MS = _env_int("NEURO_STREAM_END_MS", _cfg_num("end_silence_ms", 1600))
BARGE_END_SILENCE_MS = _env_int("NEURO_STREAM_BARGE_END_MS", _cfg_num("barge_end_silence_ms", 800))
PAD_MS = _env_int("NEURO_STREAM_PAD_MS", _cfg_num("pad_ms", 750))
TAIL_MS = _env_int("NEURO_STREAM_TAIL_MS", _cfg_num("tail_ms", 450))
MAX_UTT_S = _env_int("NEURO_STREAM_MAX_UTT_S", 15)
KEEP_S = _env_int("NEURO_STREAM_KEEP_S", 20)
MIN_UTT_S = 0.5
TAIL_VOICE_THRESH = _env_float("NEURO_STREAM_TAIL_THRESH", _cfg_num("tail_voice_thresh", 0.25))

SHORTCUT_MIN_S = _env_float("NEURO_STREAM_SHORTCUT_MIN_S", 0.8)

MIN_SPEECH_FRAMES = max(1, MIN_SPEECH_MS * SR // 1000 // FRAME)
END_SILENCE_FRAMES = max(1, END_SILENCE_MS * SR // 1000 // FRAME)
BARGE_END_SILENCE_FRAMES = max(1, BARGE_END_SILENCE_MS * SR // 1000 // FRAME)
PAD_SAMPLES = PAD_MS * SR // 1000
TAIL_SAMPLES = TAIL_MS * SR // 1000
FAN_TAIL_SAMPLES = _env_int("NEURO_STREAM_FAN_TAIL_MS", 100) * SR // 1000
MAX_UTT_SAMPLES = MAX_UTT_S * SR
KEEP_SAMPLES = KEEP_S * SR
MIN_UTT_SAMPLES = MIN_UTT_S * SR
SHORTCUT_MIN_SAMPLES = int(SHORTCUT_MIN_S * SR)

_vad_lock = threading.Lock()
_vad_session = None


def _get_vad_session():

    global _vad_session
    if _vad_session is None:
        from faster_whisper.vad import get_vad_model
        _vad_session = get_vad_model().session
    return _vad_session


F0_MIN_HZ = 70.0
F0_MAX_HZ = 320.0
MALE_BAND_MAX_HZ = 160.0
FEMALE_BAND_MIN_HZ = 175.0


def _estimate_f0(x, sr=16000, fmin=F0_MIN_HZ, fmax=F0_MAX_HZ, win=1024):

    x = np.asarray(x, dtype=np.float32).reshape(-1)
    if x.size < win:
        x = np.pad(x, (0, win - x.size))
    x = x[-win:].astype(np.float64)
    x = x - x.mean()
    rms = float(np.sqrt(np.mean(x * x)))
    if rms < 0.0035:
        return 0.0, rms
    if float(np.count_nonzero(x)) / x.size < 0.6:
        return 0.0, rms
    n = x.size
    fft_size = 1
    while fft_size < 2 * n:
        fft_size <<= 1
    F = np.fft.rfft(x, fft_size)
    ac = np.fft.irfft(F * np.conj(F), fft_size)[:n]
    if ac.size == 0 or ac[0] <= 0:
        return 0.0, rms
    ac = ac / ac[0]
    lag_min = max(2, int(sr / fmax))
    lag_max = min(n - 2, int(sr / fmin))
    if lag_max <= lag_min:
        return 0.0, rms
    seg = ac[lag_min:lag_max]
    if seg.size == 0:
        return 0.0, rms
    idx = int(np.argmax(seg)) + lag_min
    if ac[idx] < 0.30:
        return 0.0, rms
    _peak = float(ac[idx])
    _j = idx
    while _j - 1 >= lag_min and ac[_j - 1] >= _peak * 0.85:
        _j -= 1
    idx = _j
    delta = 0.0
    if 0 < idx < n - 1:
        a0, b0, c0 = ac[idx - 1], ac[idx], ac[idx + 1]
        den = (a0 - 2 * b0 + c0)
        if den != 0:
            delta = 0.5 * (a0 - c0) / den
    f0 = sr / float(idx + delta)
    if not (fmin <= f0 <= fmax):
        return 0.0, rms
    return float(f0), rms


def _is_sustained(f0_hist, min_frames=12, std_thresh=6.0):

    if len(f0_hist) < min_frames:
        return False
    arr = np.asarray(list(f0_hist)[-min_frames:], dtype=np.float64)
    return float(arr.std()) < std_thresh


def _voice_band(f0):

    if f0 <= 0:
        return "unknown"
    if f0 <= MALE_BAND_MAX_HZ:
        return "male"
    if f0 >= FEMALE_BAND_MIN_HZ:
        return "female"
    return "unknown"


class StreamSession:

    def __init__(self, sid="?"):
        self.sid = sid
        self.created_at = time.time()
        self.last_active = time.time()
        self._chunks = []
        self._next_abs = 0
        self._pending = np.zeros(0, dtype=np.float32)
        self._h = np.zeros((1, 1, 128), dtype="float32")
        self._c = np.zeros((1, 1, 128), dtype="float32")
        self._ctx = np.zeros(64, dtype=np.float32)
        self._warm_state()
        self._in_speech = False
        self._speech_run = 0
        self._speech_start_abs = 0
        self._silence_run = 0
        self._utt_start = 0
        self._tts = False
        self._closed = False
        self._resume_frames = 0
        self._ctx_reset_at = 0.0
        self._f0_hist = deque(maxlen=24)
        self._voiced_hist = deque(maxlen=24)
        self._hold_frames = 0
        self._lastUserVoiceEnd = 0
        self._lastVoiceEndAbs = 0
        self._f0win = np.zeros(1024, dtype=np.float32)
        self._polluted_run = 0
        self._male_frames = 0
        self._female_frames = 0
        self._paused = False
        self._pending_utt = None
        self._pending_since = 0.0
        self._pending_utt_start = None
        self._last_cut_start = None
        self.frames = 0
        self.speech_frames = 0
        self.utterances = 0
        self.shortcut_merged = 0
        self.shortcut_dropped = 0
        self._probe_n = 0
        self._probe_rms = 0.0
        self._probe_maxp = 0.0


    def feed(self, pcm16_bytes):

        self.last_active = time.time()
        if not pcm16_bytes:
            return []
        audio = np.frombuffer(pcm16_bytes, dtype="<i2").astype(np.float32) / 32768.0
        if audio.size == 0:
            return []
        self._probe_n += 1
        self._probe_rms += float(np.sqrt(np.mean(np.square(audio))))
        self._append(audio)
        events = self._run_vad(audio)
        out = []
        _barge_cut = bool(getattr(self, "_tts", False))
        for ev in events:
            out.extend(self._merge_short(ev, _barge_cut))
        if self._probe_n >= 150:
            _dprint(f"[stream:{self.sid}] 探针: 近5s 音频RMS={self._probe_rms / self._probe_n:.4f} "
                    f"VAD最高概率={self._probe_maxp:.2f}(阈值{SPEECH_THRESH}) "
                    f"累计语音帧={self.speech_frames}")
            self._probe_n = 0
            self._probe_rms = 0.0
            self._probe_maxp = 0.0
        if self._paused:
            self._pending_utt = None
            return []
        return out

    def _merge_short(self, audio, barge=False):

        if audio is None:
            return []
        n = audio.size
        pend = self._pending_utt
        if barge:
            if pend is not None:
                merged = np.concatenate([pend, audio]).astype(np.float32)
                self._pending_utt = None
                self.shortcut_merged += 1
                return [merged]
            return [audio.astype(np.float32)]
        if n >= SHORTCUT_MIN_SAMPLES:
            if pend is not None:
                merged = np.concatenate([pend, audio]).astype(np.float32)
                self._pending_utt = None
                self.shortcut_merged += 1
                return [merged]
            return [audio]
        merged = audio.astype(np.float32) if pend is None else \
            np.concatenate([pend, audio]).astype(np.float32)
        if pend is None:
            self._pending_since = time.time()
            self._pending_utt_start = self._last_cut_start
        self._pending_utt = merged
        if merged.size >= SHORTCUT_MIN_SAMPLES:
            self._pending_utt = None
            return [merged]
        return []

    def flush_pending(self):

        pend = self._pending_utt
        if pend is None:
            return []
        self._pending_utt = None
        if pend.size < MIN_UTT_SAMPLES:
            self.shortcut_dropped += 1
            return []
        if pend.size >= SHORTCUT_MIN_SAMPLES:
            return [pend]
        padded = self._pad_isolated(pend)
        if padded is not None and padded.size > pend.size:
            return [padded]
        return [pend]

    def _pad_isolated(self, pend, pad_s=0.5):

        try:
            start = self._pending_utt_start
            if start is None:
                return None
            pad = int(pad_s * SR)
            lo = max(start - pad, self._buffer_start())
            hi = min(start + pend.size + pad, self._next_abs)
            if hi - lo < pend.size:
                return None
            parts = []
            for cstart, buf in self._chunks:
                cend = cstart + buf.size
                a, b = max(lo, cstart), min(hi, cend)
                if b > a:
                    parts.append(buf[a - cstart: b - cstart])
            if not parts:
                return None
            merged = np.concatenate(parts).astype(np.float32)
            return merged if merged.size > pend.size else None
        except Exception:
            return None

    def _append(self, audio):
        self._chunks.append((self._next_abs, audio))
        self._next_abs += audio.size
        floor = self._next_abs - KEEP_SAMPLES
        if self._in_speech:
            floor = min(floor, self._utt_start - PAD_SAMPLES)
        while len(self._chunks) > 1:
            start, buf = self._chunks[0]
            if start + buf.size > floor:
                break
            self._chunks.pop(0)


    def _warm_state(self):

        try:
            silence = np.zeros(int(0.5 * SR), dtype=np.float32)
            n = silence.size // FRAME
            frames = silence[: n * FRAME].reshape(n, FRAME)
            ctxs = np.empty((n, 64), dtype=np.float32)
            if n > 1:
                ctxs[1:] = frames[:-1, -64:]
            ctxs[0] = self._ctx
            x = np.concatenate([ctxs, frames], axis=1)
            _out, self._h, self._c = _get_vad_session().run(
                None, {"input": x, "h": self._h, "c": self._c})
            self._ctx = frames[-1, -64:].copy()
        except Exception:
            pass

    def _run_vad(self, new_audio):

        total = np.concatenate([self._pending, new_audio])
        n = total.size // FRAME
        if n == 0:
            self._pending = total
            return []
        frames = total[: n * FRAME].reshape(n, FRAME)
        self._pending = total[n * FRAME:].copy()
        ctxs = np.empty((n, 64), dtype=np.float32)
        if n > 1:
            ctxs[1:] = frames[:-1, -64:]
        ctxs[0] = self._ctx
        x = np.concatenate([ctxs, frames], axis=1)
        out, self._h, self._c = _get_vad_session().run(
            None, {"input": x, "h": self._h, "c": self._c})
        probs = np.asarray(out, dtype=np.float32).reshape(-1)
        self._ctx = frames[-1, -64:].copy()
        if probs.size:
            self._probe_maxp = max(self._probe_maxp, float(probs.max()))
        base_abs = self._next_abs - self._pending.size - n * FRAME
        events = []
        for i in range(n):
            self.frames += 1
            if probs[i] >= SPEECH_THRESH:
                self.speech_frames += 1
            self._f0win = np.concatenate([self._f0win, frames[i]])[-1024:]
            f0, frms = _estimate_f0(self._f0win)
            voice = _voice_band(f0)
            if voice != "sustained":
                self._lastUserVoiceEnd = base_abs + i * FRAME
            if voice == "male":
                self._f0_hist.append(f0)
                self._voiced_hist.append(1)
            else:
                self._f0_hist.clear()
                self._voiced_hist.append(0)
            if voice == "male":
                if _is_sustained(self._f0_hist):
                    voice = "sustained"
                elif len(self._f0_hist) < 8:
                    voice = "uncertain"
                else:
                    _arr = np.asarray(list(self._f0_hist)[-12:], dtype=np.float64)
                    if float(_arr.std()) > 120.0:
                        voice = "uncertain"
                    else:
                        _duty = sum(self._voiced_hist) / float(len(self._voiced_hist))
                        if _duty > 0.85:
                            voice = "sustained"
            if voice == "male" and frms > 0.01:
                self._male_frames += 1
            elif voice == "female":
                self._female_frames += 1
            if (voice not in ("sustained", "female")
                    and (float(probs[i]) >= 0.15
                         or voice == "male" or frms > 0.008)):
                self._lastVoiceEndAbs = base_abs + (i + 1) * FRAME
            ev = self._frame_step(float(probs[i]), base_abs + i * FRAME, voice, frms)
            if ev is not None:
                events.append(ev)
        return events

    def _frame_step(self, prob, abs_start, voice="unknown", frms=0.0):

        if getattr(self, "_tts", False):
            if voice == "female":
                return self._silence_step(prob, abs_start, frms)
            if voice == "unknown" and frms > 0.012:
                return self._silence_step(prob, abs_start, frms)
        try:
            if (not self._in_speech
                    and time.time() - getattr(self, '_ctx_reset_at', 0.0) > 20.0):
                self._ctx = np.zeros(64, dtype=np.float32)
                self._ctx_reset_at = time.time()
        except Exception:
            pass
        if not self._in_speech and voice != "sustained":
            if frms > 0.012 and prob < 0.4:
                self._polluted_run += 1
                if self._polluted_run >= 32:
                    try:
                        self._ctx = np.zeros(64, dtype=np.float32)
                    except Exception:
                        pass
                    self._polluted_run = 0
            else:
                self._polluted_run = 0
        if voice == "sustained":
            if self._in_speech:
                self._silence_run += 1
                if self._silence_run >= END_SILENCE_FRAMES:
                    last_speech_end = abs_start - (self._silence_run - 1) * FRAME
                    end = min(last_speech_end + FAN_TAIL_SAMPLES,
                              self._lastUserVoiceEnd + FAN_TAIL_SAMPLES)
                    audio = self._cut(self._utt_start, end)
                    self._reset_speech()
                    return audio
            else:
                self._reset_speech()
            return None

        if voice == "male" and frms > 0.012 and prob < SPEECH_THRESH:
            prob = SPEECH_THRESH
        if prob >= SPEECH_THRESH:
            self._silence_run = 0
            self._quiet_frames = 0
            self._hold_frames = 0
            if not self._in_speech:
                if self._speech_run == 0:
                    self._speech_start_abs = abs_start
                self._speech_run += 1
                if self._speech_run >= MIN_SPEECH_FRAMES:
                    self._in_speech = True
                    self._utt_start = max(self._speech_start_abs - PAD_SAMPLES,
                                          self._buffer_start())
            return None
        if self._in_speech:
            if voice == "male" and frms > 0.012 and self._hold_frames < 20:
                self._hold_frames += 1
                self._silence_run = 0
                return None
            self._hold_frames = 0
            self._silence_run += 1
            _end_frames = BARGE_END_SILENCE_FRAMES if self._tts else END_SILENCE_FRAMES
            if self._silence_run >= _end_frames:
                last_speech_end = abs_start - (self._silence_run - 1) * FRAME
                voice_end = max(last_speech_end, getattr(self, '_lastVoiceEndAbs', 0))
                end = min(voice_end + TAIL_SAMPLES, self._next_abs)
                audio = self._cut(self._utt_start, end)
                self._reset_speech()
                return audio
        else:
            self._quiet_frames = getattr(self, '_quiet_frames', 0) + 1
            if self._quiet_frames >= 32 and not self._in_speech:
                try:
                    self._ctx = np.zeros(64, dtype=np.float32)
                except Exception:
                    pass
            if voice == "male" and frms > 0.012:
                self._speech_run = max(self._speech_run, 1)
            else:
                self._speech_run = max(0, self._speech_run - 1)

        if self._in_speech and (abs_start + FRAME - self._utt_start) > MAX_UTT_SAMPLES:
            audio = self._cut(self._utt_start, abs_start + FRAME)
            self._reset_speech()
            return audio

        return None

    def _silence_step(self, prob, abs_start, frms):

        if self._in_speech:
            self._hold_frames = 0
            self._silence_run += 1
            _end_frames = BARGE_END_SILENCE_FRAMES if self._tts else END_SILENCE_FRAMES
            if self._silence_run >= _end_frames:
                last_speech_end = abs_start - (self._silence_run - 1) * FRAME
                voice_end = max(last_speech_end, getattr(self, '_lastVoiceEndAbs', 0))
                end = min(voice_end + TAIL_SAMPLES, self._next_abs)
                audio = self._cut(self._utt_start, end)
                self._reset_speech()
                return audio
        else:
            self._speech_run = max(0, self._speech_run - 1)
        return None

    def _reset_speech(self):
        self._in_speech = False
        self._speech_run = 0
        self._silence_run = 0


    def set_tts(self, playing, rewind_ms=None):

        self._tts = bool(playing)
        self._resume_frames = 0

    def set_paused(self, paused):

        self._paused = bool(paused)
        if paused:
            self._pending_utt = None

    def reset(self):

        self._chunks = []
        self._next_abs = 0
        self._pending = np.zeros(0, dtype=np.float32)
        self._h = np.zeros((1, 1, 128), dtype="float32")
        self._c = np.zeros((1, 1, 128), dtype="float32")
        self._ctx = np.zeros(64, dtype=np.float32)
        self._warm_state()
        self._reset_speech()


    def _buffer_start(self):
        return self._chunks[0][0] if self._chunks else 0

    def _cut(self, start_abs, end_abs):

        start_abs = max(start_abs, self._buffer_start())
        end_abs = min(end_abs, self._next_abs)
        if end_abs - start_abs < MIN_UTT_S * SR:
            return None
        parts = []
        for cstart, buf in self._chunks:
            cend = cstart + buf.size
            lo, hi = max(start_abs, cstart), min(end_abs, cend)
            if hi > lo:
                parts.append(buf[lo - cstart: hi - cstart])
        if not parts:
            return None
        self.utterances += 1
        self._last_cut_start = start_abs
        return np.concatenate(parts).astype(np.float32)


    def handle_control(self, text):

        try:
            d = json.loads(text)
        except Exception:
            return
        if not isinstance(d, dict):
            return
        if d.get("interrupt"):
            if d.get("hint") == "acoustic":
                _dprint(f"[stream:{self.sid}] INTERRUPT 声学候选：仅记录，保持 tts={int(self._tts)} 门控，等文本确认")
            elif d.get("rewind_ms"):
                _dprint(f"[stream:{self.sid}] INTERRUPT 用户打断（旧版 barge-in）→ 从 {d['rewind_ms']}ms 前回溯")
            else:
                _dprint(f"[stream:{self.sid}] INTERRUPT 文本门控确认 → 停止她的语音输出")
            if d.get("hint") != "acoustic":
                try:
                    self._resume_frames = 0
                    self._tts = False
                except Exception:
                    pass
        if d.get("reset"):
            self.reset()
            return
        if "paused" in d:
            self.set_paused(bool(d["paused"]))
        if "tts" in d:
            rewind = d.get("rewind_ms")
            self.set_tts(bool(d["tts"]), rewind if rewind else None)

    def stats(self):
        return {
            "sid": self.sid, "frames": self.frames,
            "speech_frames": self.speech_frames,
            "speech_ratio": round(self.speech_frames / max(1, self.frames), 3),
            "utterances": self.utterances,
            "shortcut_merged": self.shortcut_merged,
            "shortcut_dropped": self.shortcut_dropped,
            "buffered_s": round((self._next_abs - self._buffer_start()) / SR, 1),
            "in_speech": self._in_speech, "tts": self._tts, "paused": self._paused,
        }


_sessions = {}
_sessions_lock = threading.Lock()
MAX_SESSIONS = 4


def register_session(session):

    with _sessions_lock:
        while len(_sessions) >= MAX_SESSIONS:
            _oldest_id = next(iter(_sessions))
            _oldest = _sessions.pop(_oldest_id)
            try:
                _oldest._closed = True
            except Exception:
                pass
        _sessions[id(session)] = session
        return True


def unregister_session(session):
    with _sessions_lock:
        _sessions.pop(id(session), None)


def session_stats():
    with _sessions_lock:
        return [s.stats() for s in _sessions.values()]
