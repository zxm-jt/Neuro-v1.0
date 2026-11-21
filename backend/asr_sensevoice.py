import os
import re
import time

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "sensevoice")
_DIAG_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "logs", "backend_diag.log")

_recognizer = None
_load_error = None


def _dprint(*args):
    try:
        line = "[" + time.strftime("%H:%M:%S") + "] " + " ".join(str(a) for a in args)
        with open(_DIAG_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def is_ready():

    return (os.path.exists(os.path.join(MODEL_DIR, "model.int8.onnx"))
            and os.path.exists(os.path.join(MODEL_DIR, "tokens.txt")))


def _load():

    global _recognizer, _load_error
    if _recognizer is not None:
        return _recognizer
    if _load_error is not None:
        raise _load_error
    try:
        import sherpa_onnx
        _recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=os.path.join(MODEL_DIR, "model.int8.onnx"),
            tokens=os.path.join(MODEL_DIR, "tokens.txt"),
            num_threads=2,
            use_itn=True,
            debug=False,
        )
        _dprint("[SenseVoice] 模型加载完成:", os.path.join(MODEL_DIR, "model.int8.onnx"))
        return _recognizer
    except Exception as e:
        _load_error = e
        _dprint(f"[SenseVoice] 模型加载失败: {e}")
        raise


_TAG_RE = re.compile(r"<\|[^|]*\|>")
_LANG_RE = re.compile(r"<\|(zh|en|yue|ja|ko)\|>")


def transcribe(pcm_f32, sample_rate=16000):

    import numpy as np
    rec = _load()
    stream = rec.create_stream()
    stream.accept_waveform(sample_rate, np.ascontiguousarray(pcm_f32, dtype=np.float32))
    rec.decode_stream(stream)
    raw = stream.result.text or ""
    m = _LANG_RE.search(raw)
    lang = m.group(1) if m else None
    text = _TAG_RE.sub("", raw).strip()
    return text, lang
