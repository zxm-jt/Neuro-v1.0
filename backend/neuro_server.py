import asyncio
import io
import json
import math
import os
import re
import shutil
import time
import urllib.request
import urllib.error
import threading
import wave
import re
import base64
import uuid

import numpy as np
from fastapi import FastAPI, File, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from starlette.concurrency import run_in_threadpool
from starlette.websockets import WebSocket, WebSocketDisconnect

import stream_asr
import asr_corrector

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))

def _resolve_config():
    env = (os.environ.get("NEURO_CONFIG") or "").strip()
    if env and os.path.isfile(env):
        return env, f"[backend] 配置来源: NEURO_CONFIG={env}"
    desktop = os.path.join(os.path.expanduser("~"), "Desktop", "config.json")
    note = f"[backend] 配置来源: 项目内 config.json（{BASE_DIR}）"
    if os.path.isfile(desktop):
        note += f"  ← 注意：桌面另有一份旧副本 {desktop} 已不再使用，可删除以免混淆"
    return os.path.join(BASE_DIR, "config.json"), note


CONFIG_FILE, _CONFIG_NOTE = _resolve_config()

SR = 16000

import secret_store


def _load_cfg_dict():

    try:
        return secret_store.load_config(CONFIG_FILE)
    except Exception:
        return {}


_DEFAULT_USER_NAME = "user"


def _user_name() -> str:

    try:
        cfg = _load_cfg_dict()
        name = (cfg.get("user") or {}).get("name") or ""
        return name.strip() if name.strip() else _DEFAULT_USER_NAME
    except Exception:
        return _DEFAULT_USER_NAME


def _user_asked() -> bool:

    try:
        cfg = _load_cfg_dict()
        return bool((cfg.get("user") or {}).get("asked"))
    except Exception:
        return True


def _set_user_name(name: str) -> bool:

    try:
        name = (name or "").strip()
        if not name:
            return False
        import json as _json
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            cfg = _json.load(f)
        cfg.setdefault("user", {})
        cfg["user"]["name"] = name
        cfg["user"]["asked"] = True
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            _json.dump(cfg, f, ensure_ascii=False, indent=2)
        return True
    except Exception:
        return False


def _apply_user_name(text: str) -> str:

    if not text:
        return text
    name = _user_name()
    text = text.replace("{user_name}", name)
    if name and name != "user":
        import re as _re
        text = _re.sub(r"(?<!\.)\buser\b(?!\.\w)", name, text)
    return text


def _cfg_asr_online():

    return (_load_cfg_dict().get("asr") or {}).get("online") or {}


def _cfg_tts(key, default):
    return _load_cfg_dict().get("tts", {}).get(key, default)


def _cfg_llm(key, default):
    return _load_cfg_dict().get("llm", {}).get(key, default)


def _cfg_vision(key, default):

    return _load_cfg_dict().get("vision", {}).get(key, default)


VERBOSE = os.environ.get("NEURO_VERBOSE", "").strip().lower() in ("1", "true", "yes")


_DIAG_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "logs", "backend_diag.log")
_DIAG_LOG_MAX = 8 * 1024 * 1024
_diag_calls = 0


def _sanitize_json(obj):

    if isinstance(obj, float):
        return obj if math.isfinite(obj) else 0.0
    if isinstance(obj, dict):
        return {k: _sanitize_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize_json(v) for v in obj]
    return obj


def dprint(*args, **kwargs):

    global _diag_calls
    try:
        line = "[" + time.strftime("%H:%M:%S") + "] " + " ".join(str(a) for a in args)
        os.makedirs(os.path.dirname(_DIAG_LOG), exist_ok=True)
        _diag_calls += 1
        if _diag_calls % 200 == 0:
            try:
                if os.path.getsize(_DIAG_LOG) > _DIAG_LOG_MAX:
                    _bak = _DIAG_LOG + ".1"
                    if os.path.exists(_bak):
                        os.remove(_bak)
                    os.replace(_DIAG_LOG, _bak)
            except Exception:
                pass
        with open(_DIAG_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        if VERBOSE:
            print(*args, **kwargs)
    except Exception:
        pass

TTS_VOICE_EN = os.environ.get("NEURO_TTS_VOICE_EN", _cfg_tts("en_voice", "en-US-AvaMultilingualNeural"))
TTS_PITCH = os.environ.get("NEURO_TTS_PITCH", _cfg_tts("pitch", "+32Hz"))
TTS_RATE = os.environ.get("NEURO_TTS_RATE", _cfg_tts("rate", "+0%"))
TTS_VOLUME = os.environ.get("NEURO_TTS_VOLUME", _cfg_tts("volume", "+40%"))


def _tts_volume(v):
    import re as _re
    m = _re.search(r"[-+]?\d+", str(v if v is not None else ""))
    n = int(m.group(0)) if m else 0
    n = max(-100, min(100, n))
    return f"{n:+d}%"


def _make_comm(edge_tts, text, voice, pitch, rate, volume=None):
    vol = _tts_volume(volume if volume not in (None, "") else TTS_VOLUME)
    try:
        return edge_tts.Communicate(text, voice, pitch=pitch, rate=rate, volume=vol)
    except TypeError:
        return edge_tts.Communicate(text, voice, pitch=pitch, rate=rate)

ASR_LANG_DEFAULT = os.environ.get("NEURO_ASR_LANG", "zh")
ASR_TASK = os.environ.get("NEURO_ASR_TASK", "translate")

_ASR_BASE_PROMPT = (
    "The AI companion's name is Neuro. "
    "user and Neuro are talking casually. "
    "Proper nouns: Neuro, user."
)

ASR_LLM_CORRECT = bool((_cfg_asr_online().get("correct_with_llm", True)))

_ASR_BUSY_LOCK = threading.Lock()
_asr_busy = False
_asr_started_at = 0.0

_WHISPER_DECODE_LOCK = threading.RLock()

def _upstream_slot(timeout=60.0):

    try:
        import agent_bridge as ab
        return ab._paced_slot(timeout=timeout)
    except Exception:
        return _local_slot(timeout=timeout)


_LOCAL_SLOT_LOCK = threading.Lock()
_LOCAL_SLOT_BUSY = False


def _local_slot(timeout=60.0):
    global _LOCAL_SLOT_BUSY
    t0 = time.time()
    with _LOCAL_SLOT_LOCK:
        while _LOCAL_SLOT_BUSY:
            if time.time() - t0 > timeout:
                return False, "等待上游单飞名额超时"
            time.sleep(0.08)
        _LOCAL_SLOT_BUSY = True
    return True, ""


def _release_slot():

    global _LOCAL_SLOT_BUSY
    try:
        import agent_bridge as ab
        ab._paced_release()
    except Exception:
        pass
    with _LOCAL_SLOT_LOCK:
        _LOCAL_SLOT_BUSY = False
_LLM_UPSTREAM = os.environ.get("NEURO_LLM_UPSTREAM", _cfg_llm("upstream_url", "https://api.deepseek.com/v1"))
_LLM_KEY = os.environ.get("NEURO_LLM_KEY", _cfg_llm("api_key", ""))
_LLM_MODEL = os.environ.get("NEURO_LLM_MODEL", _cfg_llm("model", "kimi-k2.7-code"))
_LLM_FAST_MODEL = os.environ.get("NEURO_LLM_FAST_MODEL", _cfg_llm("fast_model", "")) or _LLM_MODEL


_conv_history = []
_conv_history_lock = None


_PICT_RE = re.compile(
    "[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF"
    "\uFE00-\uFE0F\u3030\u303D\u2049\u203C]"
)


def _plain_text(s):

    t = str(s)
    t = _PICT_RE.sub("", t)
    t = re.sub(r"[\u200B-\u200D\uFEFF]", "", t)
    t = re.sub(r"[ \t]{2,}", " ", t)
    return re.sub(r"\s+([,;:.!?])", r"\1", t)


def _strip_reply_artifacts(s):

    t = re.sub(r"\(think\)", "", str(s), flags=re.I)
    t = re.sub(r"^\s*[A-Z][ \t]{2,}(?=[A-Z])", "", t)
    return t


def _clean_final_text(s):

    t = _plain_text(s)
    try:
        import agent_bridge as _ab
        t = _ab.clean_visible(t)
    except Exception:
        pass
    return _strip_reply_artifacts(t)


_CHAT_LOG = os.path.join(BACKEND_DIR, "chat_log.txt")
MAX_CHAT_LOG_LINES = 60

_CHAT_SUBS = set()
_CHAT_LOOP = None


def _chat_publish(line):

    loop = _CHAT_LOOP
    if not loop:
        return
    for q in list(_CHAT_SUBS):
        try:
            loop.call_soon_threadsafe(q.put_nowait, line)
        except Exception:
            pass


def _read_chat_tail(n=30):

    try:
        with open(_CHAT_LOG, "r", encoding="utf-8") as f:
            lines = f.read().splitlines()
        return lines[-n:] if n > 0 else []
    except Exception:
        return []


def mark_session_start():

    try:
        try:
            if os.path.exists(_CHAT_LOG) and os.path.getsize(_CHAT_LOG) > 0:
                _prev_log = os.path.join(BASE_DIR, "logs", "chat_log.prev.txt")
                try:
                    os.makedirs(os.path.dirname(_prev_log), exist_ok=True)
                except Exception:
                    pass
                try:
                    os.replace(_CHAT_LOG, _prev_log)
                except Exception:
                    with open(_CHAT_LOG, "r", encoding="utf-8", errors="ignore") as _f:
                        _old = _f.read()
                    with open(_prev_log, "w", encoding="utf-8") as _f:
                        _f.write(_old)
                    with open(_CHAT_LOG, "w", encoding="utf-8"):
                        pass
        except Exception as _e:
            dprint(f"[session] 旧对话归档失败（忽略）: {_e}", flush=True)
        ts = time.strftime("%H:%M:%S")
        line = f"[{ts}] session: ===== 新会话开始 ====="
        with open(_CHAT_LOG, "w", encoding="utf-8") as f:
            f.write(line + "\n")
        dprint(f"[session] 已清空上次对话并写入会话标记: {line}")
    except Exception:
        pass
    try:
        _lock = _conv_history_lock
        if _lock is not None:
            with _lock:
                _conv_history.clear()
        else:
            _conv_history.clear()
    except Exception:
        pass


def log_chat(kind, text):

    if not text:
        return
    try:
        ts = time.strftime("%H:%M:%S")
        safe = _plain_text(text).replace("\r", " ").replace("\n", " ")
        who = {"原话(ASR)": "user", "修正为": "user", "她说": "neuro",
               "她说(识图)": "neuro", "意图判定": "系统"}.get(kind)
        label = f"{who}" if who else kind
        line = f"[{ts}] {label}: {safe}"
        if who in ("user", "neuro"):
            print(line, flush=True)
        else:
            dprint(line)
        with open(_CHAT_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        _chat_publish(line)
        with open(_CHAT_LOG, "r", encoding="utf-8", errors="ignore") as f:
            _lines = f.readlines()
        if len(_lines) > MAX_CHAT_LOG_LINES:
            # 【2026-11-22 修 · 聊天房整屏清空】会话标记是文件的【第 1 行】，
            # 而旧写法保留【最后 60 行】—— 一旦超过 60 行，标记必然被挤掉。
            # 前端 buildRoomChat 找不到标记就返回空数组 → 整屏对话消失。
            # 改成：永远保留首行标记 + 末尾 (MAX-1) 行对话。
            _keep = list(_lines[:1]) + list(_lines[-(MAX_CHAT_LOG_LINES - 1):])
            with open(_CHAT_LOG, "w", encoding="utf-8") as f:
                f.writelines(_keep)
    except Exception:
        pass


from contextlib import asynccontextmanager

_BRIDGE_LOCK = threading.Lock()
_BRIDGE_PROC = None
_BRIDGE_LOG = None


def _bridge_settings() -> dict:
    try:
        cfg = _load_cfg_dict() or {}
        fb = cfg.get("flybridge") or {}
    except Exception:
        fb = {}
    return {"enabled": bool(fb.get("enabled", True)),
            "auto": bool(fb.get("auto_start", True)),
            "url": str(fb.get("url") or "http://127.0.0.1:6007"),
            "hz": float(fb.get("hz") or 30)}


def _bridge_alive(url: str, timeout: float = 0.4) -> bool:
    try:
        with urllib.request.urlopen(str(url).rstrip("/") + "/health", timeout=timeout) as r:
            return int(getattr(r, "status", 200) or 200) == 200
    except Exception:
        return False


def _bridge_start():

    global _BRIDGE_PROC, _BRIDGE_LOG
    s = _bridge_settings()
    if not s["enabled"] or not s["auto"]:
        dprint("[bridge] 未启用自动启动（config.flybridge）", flush=True)
        return None
    if _bridge_alive(s["url"]):
        dprint("[bridge] 已在运行，复用现有进程", flush=True)
        return None
    with _BRIDGE_LOCK:
        if _BRIDGE_PROC is not None and _BRIDGE_PROC.poll() is None:
            return _BRIDGE_PROC
        try:
            import subprocess
            import sys
            from pathlib import Path
            from urllib.parse import urlparse
            port = urlparse(s["url"]).port or 6007
            root = Path(__file__).resolve().parent.parent
            logp = root / "logs" / "bridge_auto.log"
            logp.parent.mkdir(parents=True, exist_ok=True)
            _BRIDGE_LOG = open(str(logp), "ab")
            flags = 0x08000000 if os.name == "nt" else 0
            _env = dict(os.environ)
            _nt = str(os.environ.get("NEURO_NUMBA_THREADS", "2")).strip()
            if _nt and _nt != "0":
                _env["NUMBA_NUM_THREADS"] = _nt
            _BRIDGE_PROC = subprocess.Popen(
                [sys.executable, "-m", "flybridge.brain_server",
                 "--port", str(port), "--hz", str(s["hz"]), "--managed"],
                cwd=str(root), stdout=_BRIDGE_LOG, stderr=subprocess.STDOUT,
                creationflags=flags, env=_env)
            dprint(f"[bridge] 已启动 pid={_BRIDGE_PROC.pid} port={port} hz={s['hz']}"
                   f"（首帧约 2s，numba 编译）", flush=True)
            return _BRIDGE_PROC
        except Exception as e:
            dprint(f"[bridge] 启动失败: {e}", flush=True)
            return None


def _bridge_stop():
    global _BRIDGE_PROC, _BRIDGE_LOG
    with _BRIDGE_LOCK:
        p = _BRIDGE_PROC
        _BRIDGE_PROC = None
    if p is None or p.poll() is not None:
        return
    try:
        import urllib.request as _u
        req = _u.Request(f"{_bridge_settings()['url'].rstrip('/')}/shutdown", data=b"{}",
                         headers={"Content-Type": "application/json"})
        _u.urlopen(req, timeout=6).read()
        p.wait(timeout=8)
        dprint("[bridge] 优雅停机完成（已巩固并存盘）", flush=True)
        return
    except Exception as e:
        dprint(f"[bridge] 优雅停机失败，改硬杀: {e}", flush=True)
    try:
        p.terminate()
        p.wait(timeout=4)
    except Exception:
        try:
            p.kill()
        except Exception:
            pass
    try:
        if _BRIDGE_LOG:
            _BRIDGE_LOG.close()
            _BRIDGE_LOG = None
    except Exception:
        pass
    dprint("[bridge] 已停止（存档在 flybridge/state）", flush=True)

@asynccontextmanager
async def _lifespan(_app: FastAPI):
    _startup_prewarm()
    try:
        _bridge_start()
    except Exception as _e:
        dprint(f"[bridge] 启动异常（回落到旧行为）: {_e}", flush=True)
    try:
        mark_session_start()
    except Exception:
        pass
    try:
        _vmgr = _get_vision_manager()
        if _vmgr and await _vmgr.start():
            _vmgr.mark_start()
            dprint("[vision] 连续注视已就绪（启动即生效）", flush=True)
        else:
            dprint("[vision] 连续注视未激活（未启用或缺 key，语音链路不受影响）", flush=True)
    except Exception as _e:
        dprint(f"[vision] 启动时激活失败（不影响语音）: {_e}", flush=True)
    _vision_worker_task = asyncio.create_task(_vision_speech_worker())
    global _IDLE_WORKER_TASK
    _IDLE_WORKER_TASK = asyncio.create_task(_idle_worker())
    try:
        yield
    finally:
        try:
            _vision_worker_task.cancel()
        except Exception:
            pass
        try:
            if _IDLE_WORKER_TASK:
                _IDLE_WORKER_TASK.cancel()
        except Exception:
            pass
        try:
            mgr = _get_vision_manager()
            if mgr:
                await mgr.stop()
        except Exception:
            pass
        try:
            _bridge_stop()
        except Exception:
            pass

app = FastAPI(lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _startup_prewarm():
    def _warm_model():
        try:
            cfg = _cfg_asr_online() or {"model": "small"}
            size = str(cfg.get("model") or "small").lower()
            model = _load_whisper(size)
            _warm_whisper_decode(model, (cfg.get("language") or "en").lower())
        except Exception as e:
            dprint(f"[startup] Whisper 预热失败（不影响首次识别，届时现场加载）: {e}",
                  flush=True)

    def _warm_vad():
        try:
            stream_asr._get_vad_session()
            dprint("[startup] 流式 Silero VAD 就绪", flush=True)
        except Exception as e:
            dprint(f"[startup] 流式 VAD 预热失败（首次说话时现场加载）: {e}",
                  flush=True)

    def _warm_tts():
        try:
            import asyncio
            asyncio.run(_warmup_edge_tts(force=True))
        except Exception as e:
            dprint(f"[startup] TTS 预热失败（不影响首次合成）: {e}", flush=True)

    def _warm_sensevoice():
        try:
            import asr_sensevoice as _sv
            if _sv.is_ready():
                _sv._load()
                dprint("[startup] SenseVoice 模型就绪")
        except Exception as e:
            dprint(f"[startup] SenseVoice 预热失败（首次识别时现场加载）: {e}")

    def _warm_asr_all():
        _warm_vad()
        _warm_sensevoice()
    threading.Thread(target=_warm_asr_all, daemon=True).start()
    threading.Thread(target=_warm_tts, daemon=True).start()
    dprint("[startup] 后台预热已启动（Whisper 模型 + TTS 连接 + 流式 VAD）", flush=True)


def to_wav_bytes(pcm_f32):

    pcm = np.asarray(pcm_f32, dtype=np.float32)
    if pcm.size == 0:
        pcm16 = np.zeros(1, dtype=np.int16)
    else:
        pcm = pcm - float(np.mean(pcm))
        peak = float(np.max(np.abs(pcm)))
        pcm = pcm * (0.89 / peak) if peak > 1e-6 else pcm * 0.0
        pcm16 = (np.clip(pcm, -1.0, 1.0) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes(pcm16.tobytes())
    return buf.getvalue()


_whisper_model = None
_whisper_model_size = None
_WHISPER_LOAD_LOCK = threading.Lock()
MODELS_DIR = os.path.join(BACKEND_DIR, "models")

_WHISPER_CACHE_DIR = os.environ.get("NEURO_MODELS_DIR") or os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"),
    "Neuro", "whisper-models")
_cache_copy_lock = threading.Lock()
_cache_copy_started = set()


def _spawn_cache_copy(src_dir, dst_dir):

    if dst_dir in _cache_copy_started:
        return
    with _cache_copy_lock:
        if dst_dir in _cache_copy_started:
            return
        _cache_copy_started.add(dst_dir)

    def _copy():
        try:
            os.makedirs(os.path.dirname(dst_dir), exist_ok=True)
            tmp = dst_dir + ".copying"
            shutil.copytree(src_dir, tmp)
            if os.path.isdir(dst_dir):
                shutil.rmtree(dst_dir, ignore_errors=True)
            os.replace(tmp, dst_dir)
            dprint(f"[ASR] 模型已缓存到 SSD: {dst_dir}（下次启动走本地 NVMe）",
                  flush=True)
        except Exception as e:
            dprint(f"[ASR] SSD 缓存复制失败（不影响使用，继续用原目录）: {e}",
                  flush=True)

    threading.Thread(target=_copy, daemon=True).start()


def _local_whisper_dir(model_size):

    name = f"faster-whisper-{model_size}"
    cached = os.path.join(_WHISPER_CACHE_DIR, name)
    if os.path.isfile(os.path.join(cached, "model.bin")):
        return cached
    d = os.path.join(MODELS_DIR, name)
    if os.path.isdir(d) and os.path.isfile(os.path.join(d, "model.bin")):
        _spawn_cache_copy(d, cached)
        return d
    return None

def _load_whisper(model_size):

    global _whisper_model, _whisper_model_size
    if _whisper_model is None or _whisper_model_size != model_size:
        with _WHISPER_LOAD_LOCK:
            if _whisper_model is None or _whisper_model_size != model_size:
                from faster_whisper import WhisperModel
                local = _local_whisper_dir(model_size)
                kw = dict(device="cpu", compute_type="int8", cpu_threads=0)
                if local:
                    dprint(f"[ASR] 加载随附 Whisper 模型: {local} (CPU, int8)", flush=True)
                    _whisper_model = WhisperModel(local, **kw)
                else:
                    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
                    dprint(f"[ASR] 联网下载 Whisper 模型: {model_size} (CPU, int8) ...", flush=True)
                    _whisper_model = WhisperModel(model_size, **kw)
                _whisper_model_size = model_size
                dprint("[ASR] 本地 Whisper 模型就绪", flush=True)
    return _whisper_model


_LAST_DECODE_AT = 0.0


def _warm_whisper_decode(model, lang):

    global _LAST_DECODE_AT
    with _WHISPER_DECODE_LOCK:
        try:
            silence = np.zeros(int(0.3 * 16000), dtype=np.float32)
            segs, _info = model.transcribe(
                silence, beam_size=1, language=lang, vad_filter=True,
                condition_on_previous_text=False)
            for _s in segs:
                pass
            segs, _info = model.transcribe(
                silence, beam_size=1, language=lang, vad_filter=False,
                condition_on_previous_text=False)
            for _s in segs:
                pass
            _LAST_DECODE_AT = time.time()
        except Exception:
            pass


_HALLUCIN_PHRASES = (
    "thank you for watching", "thanks for watching", "please subscribe",
    "subscribe to my channel", "subtitles by", "amara.org",
    "www.", "http", ".com", "transcription by", "caption by",
    "the end",
    "谢谢观看", "感谢观看", "请订阅", "订阅我的频道", "字幕由",
    "转载请注明", "视频作者", "一键三连", "下次再见", "别风扇",
)

_SHORT_HALLUCIN_WHOLE = frozenset({
    "i", "im", "ive", "ill", "id", "a", "ah", "uh", "um", "hmm", "m", "n",
    "the", "and", "it", "is", "to", "in", "on", "so",
    "thankyouforwatching",
    "嗯", "啊", "哦", "呃", "好", "是", "对", "不", "嗯嗯", "啊啊",
})
_SHORT_EN_ALLOW = frozenset({
    "ok", "hi", "hey", "oh", "no", "yes", "yep", "nah", "yup",
    "wow", "go", "bye", "user", "sup",
})


def _norm_asr_text(text):

    return re.sub(r"[\s\.,!?;:'\"。，！？；：、…\-_~～\(\)\[\]]+", "",
                  (text or "").lower())


def _cfg_backend_hold_ms():

    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            v = (json.load(f).get("asr") or {}).get("backend_hold_ms", 0)
        v = int(v)
        return max(0, min(2000, v))
    except Exception:
        return 0

_CONT_TAIL_EN = frozenset({
    "and", "but", "or", "so", "because", "cause", "if", "when", "while",
    "that", "which", "who", "with", "to", "of", "the", "a", "an", "then",
    "also", "plus", "like", "about", "for", "from", "as", "than",
    "is", "are", "was", "were", "am", "be", "will", "would", "can", "could",
    "should", "shall", "may", "might", "must", "do", "does", "did",
    "have", "has", "had", "not",
})
_CONT_TAIL_ZH = (
    "然后", "因为", "所以", "但是", "不过", "而且", "还有", "如果", "虽然",
    "那个", "就是", "这个", "要是", "等", "跟", "和", "或者", "比", "把", "被",
)
_CONT_END_PUNCT = ("，", ",", "、", "…", "...", "——", "—")


def _looks_unfinished_utterance(text):

    t = str(text or "").strip()
    if not t:
        return False
    for p in _CONT_END_PUNCT:
        if t.endswith(p):
            return True
    if t[-1] in ".!?。！？":
        return False
    for w in _CONT_TAIL_ZH:
        if t.endswith(w):
            return True
    m = re.search(r"([A-Za-z']+)\s*$", t)
    if m and m.group(1).lower() in _CONT_TAIL_EN:
        return True
    return False


def _merge_utterance_text(a, b):

    a = str(a or "").strip()
    b = str(b or "").strip()
    if not a:
        return b
    if not b:
        return a
    if re.search(r"[\u4e00-\u9fff]$", a) and re.match(r"[\u4e00-\u9fff]", b):
        return a + b
    if a.endswith(("，", "、")):
        return a + b
    return a + " " + b


def _ngram_repetition_ratio(text):

    s = re.sub(r"\s+", "", text or "")
    if len(s) < 8:
        return 0.0
    n = 4
    grams = [s[i:i + n] for i in range(len(s) - n + 1)]
    if not grams:
        return 0.0
    return 1.0 - len(set(grams)) / len(grams)


def _looks_like_hallucination(text, no_speech_prob=None,
                              avg_logprob=None, compression_ratio=None,
                              prompt=None):

    t = (text or "").strip()
    low = t.lower()
    if not t:
        return True, "空文本"

    _norm = _norm_asr_text(t)
    if _norm in _SHORT_HALLUCIN_WHOLE:
        return True, f"极短噪声幻觉('{t}')"
    if len(_norm) == 1 and _norm.isascii() and _norm.isalpha():
        return True, f"单字母噪声('{t}')"
    if not _norm:
        return True, "纯标点"
    if (2 <= len(_norm) <= 3 and _norm.isascii() and _norm.isalpha()
            and _norm not in _SHORT_EN_ALLOW):
        return True, f"极短字母碎片('{t}')"
    if (0 < len(_norm) <= 4 and not _norm.isascii()
            and not re.search(r"[\u4e00-\u9fff]", _norm)):
        return True, f"跨语种噪声碎片('{t}')"

    rr = _ngram_repetition_ratio(t)
    if rr >= 0.5:
        return True, f"重复循环(4-gram重复率{rr:.2f})"
    if compression_ratio is not None and compression_ratio > 2.4:
        return True, f"压缩率过高({compression_ratio:.2f}>2.4)"

    if (no_speech_prob is not None and no_speech_prob > 0.6
            and avg_logprob is not None and avg_logprob < -1.0):
        return True, (f"双低置信(no_speech_prob={no_speech_prob:.2f}"
                      f" avg_logprob={avg_logprob:.2f})")

    for p in _HALLUCIN_PHRASES:
        if p in low:
            return True, f"命中模板幻觉短语 '{p}'"

    if prompt:
        _p = re.sub(r"[\s\.,!?;:'\"]+", "", prompt.lower())
        _t = re.sub(r"[\s\.,!?;:'\"]+", "", low)
        if len(_t) >= 8 and _t in _p:
            return True, "提示词回声(无声时把initial_prompt吐了出来)"

    nonspace = re.sub(r"\s+", "", t)
    if len(nonspace) >= 6 and len(set(nonspace)) <= 2:
        return True, f"单字符轰炸('{nonspace[:12]}')"

    return False, ""


_CONTRACTION_FIXES = [
    (r"\bit's\b", "it is"), (r"\bthat's\b", "that is"), (r"\bhe's\b", "he is"),
    (r"\bshe's\b", "she is"), (r"\bthere's\b", "there is"), (r"\bwhat's\b", "what is"),
    (r"\bwho's\b", "who is"), (r"\bwhere's\b", "where is"), (r"\blet's\b", "let us"),
    (r"\bdon't\b", "do not"), (r"\bdoesn't\b", "does not"), (r"\bdidn't\b", "did not"),
    (r"\bcannot\b", "can not"), (r"\bcan't\b", "can not"), (r"\bwon't\b", "will not"),
    (r"\bI'm\b", "I am"), (r"\bit's\b", "it is"), (r"\byou're\b", "you are"),
    (r"\bwe're\b", "we are"), (r"\bthey're\b", "they are"), (r"\bI'd\b", "I would"),
    (r"\bI'm\b", "I am"),
]

_KEEP_CONTRACTIONS = bool(os.environ.get("NEURO_ASR_KEEP_CONTRACTIONS", "1") == "1")

_WORD_PAIRS = {
    "dandclear": "and clear", "yrightnow": "you right now", "twoscoops": "two scoops",
    "illonthetable": "ill on the table", "ecidedtosayhi": "decided to say hi",
    "mysterysolved": "mystery solved", "solvedmystery": "solved mystery",
    "craftlauncher": "craft launcher", "edtheurl": "read the URL",
    "brewelcome": "be welcome", "alauncher": "a launcher",
    "tremember": "to remember", "abrowsertab": "a browser tab",
    "inheritatitle": "inherit a title", "isthatabribe": "is that a bribe",
    "ghtcorner": "right corner", "ouldoverclock": "should overclock",
    "awberryormint": "strawberry or mint", "rfeelings": "our feelings",
    "aveplenty": "have plenty", "arewebreaking": "are we breaking",
    "erswerebroken": "hers were broken", "worksperfectly": "works perfectly",
    "pleadthefifth": "plead the fifth",
    "thewebsite": "the website", "thegame": "the game", "thecode": "the code",
    "theanswer": "the answer", "theproblem": "the problem", "thetruth": "the truth",
    "goodmorning": "good morning", "goodnight": "good night", "thankyou": "thank you",
    "welldone": "well done", "sorryabout": "sorry about", "ofcourse": "of course",
    "bytheway": "by the way", "rightnow": "right now",
    "yourright": "you are right", "yourehere": "you are here",
}


def _fix_missing_spaces(text):

    if not text:
        return text
    out = text

    for glued, fixed in _WORD_PAIRS.items():
        if not fixed:
            continue
        pat = r"(?<![A-Za-z'])(?<![^\x00-\x7F])" + re.escape(glued) + r"(?![A-Za-z'])"
        out = re.sub(pat, fixed, out, flags=re.IGNORECASE)

    if not _KEEP_CONTRACTIONS:
        for pat, rep in _CONTRACTION_FIXES:
            out = re.sub(pat, rep, out, flags=re.IGNORECASE)

    return out


def _asr_context_prompt(max_chars=180):
    try:
        if _conv_history_lock is None:
            return _ASR_BASE_PROMPT
        with _conv_history_lock:
            ctx = list(_conv_history[-6:])
    except Exception:
        return _ASR_BASE_PROMPT
    parts = []
    total = len(_ASR_BASE_PROMPT)
    for m in reversed(ctx):
        c = (m.get("content") or "").strip().replace("\n", " ")
        if not c:
            continue
        if total + len(c) + 1 > max_chars:
            break
        parts.append(c)
        total += len(c) + 1
    if not parts:
        return _ASR_BASE_PROMPT
    return _ASR_BASE_PROMPT + " " + " ".join(reversed(parts))


def _asr_local_whisper(pcm_f32, cfg, vad_filter=True):

    global _asr_busy, _asr_started_at
    _asr_t0 = time.time()
    _asr_started_at = _asr_t0
    _lock_wait_ms = 0
    with _ASR_BUSY_LOCK:
        _asr_busy = True
    try:
        audio = np.asarray(pcm_f32, dtype=np.float32)
        if audio.size == 0:
            return None
        audio = audio - float(np.mean(audio))
        peak = float(np.max(np.abs(audio)))
        if peak > 1e-6:
            audio = audio * (0.89 / peak)
        model_size = (cfg.get("model") or "small").lower()
        model = _load_whisper(model_size)
        lang = (cfg.get("language") or ASR_LANG_DEFAULT or "en").lower()
        lang = None if lang in ("auto", "") else lang
        _lock_t0 = time.time()
        with _WHISPER_DECODE_LOCK:
            _lock_wait_ms = int((time.time() - _lock_t0) * 1000)
            segments, info = model.transcribe(
                audio, beam_size=5, language=lang, task=ASR_TASK, vad_filter=vad_filter,
                initial_prompt=_asr_context_prompt(),
                condition_on_previous_text=False,
                hallucination_silence_threshold=2,
                no_speech_threshold=0.6,
                log_prob_threshold=-1.0,
                compression_ratio_threshold=2.4,
                vad_parameters=dict(
                    threshold=0.5,
                    min_speech_duration_ms=250,
                    min_silence_duration_ms=500,
                    speech_pad_ms=200,
                ),
            )
            segs = list(segments)
        text = "".join(s.text for s in segs).strip()
        text = _fix_missing_spaces(text)
        _nsp = None
        _avg_lp = None
        _cr = None
        if segs:
            try:
                _nsps = [float(getattr(s, "no_speech_prob", 0.0) or 0.0) for s in segs]
                _lps = [float(getattr(s, "avg_logprob", 0.0) or 0.0) for s in segs]
                _crs = [float(getattr(s, "compression_ratio", 0.0) or 0.0) for s in segs]
                _nsp = max(_nsps) if _nsps else None
                _avg_lp = min(_lps) if _lps else None
                _cr = max(_crs) if _crs else None
            except Exception:
                pass
        _asr_elapsed = (time.time() - _asr_t0) * 1000
        _nsp_s = f"{_nsp:.2f}" if _nsp is not None else "n/a"

        if not text:
            rms = float(np.sqrt(np.mean(np.square(audio))) if audio.size else 0.0)
            peak = float(np.max(np.abs(audio)) if audio.size else 0.0)
            dprint(f"[ASR/local:{model_size}:lang={lang or 'auto'}] "
                  f"(空结果 {_asr_elapsed:.0f}ms, 排队{_lock_wait_ms}ms, 音频{len(audio)/16000:.1f}s, "
                  f"rms={rms:.5f} peak={peak:.3f}) 已丢弃", flush=True)
            return None

        dprint(f"[ASR/local:{model_size}:lang={lang or 'auto'}] "
              f"识别完成 {_asr_elapsed:.0f}ms (排队等锁{_lock_wait_ms}ms), 音频{len(audio)/16000:.1f}s, "
              f"无语音概率={_nsp_s}", flush=True)

        _bad, _why = _looks_like_hallucination(text, _nsp, _avg_lp, _cr,
                                               _asr_context_prompt())
        if _bad:
            dprint(f"[ASR] 丢弃（{_why}）: \"{text[:50]}\" "
                  f"[nsp={_nsp_s} lp={_avg_lp:.2f} cr={_cr:.2f}]", flush=True)
            return None
        if _nsp is not None and _nsp > 0.6:
            dprint(f"[ASR] 音频质量偏差(no_speech_prob={_nsp_s})，"
                  f"但有文本，照常送去回答: \"{text[:50]}\"", flush=True)
        return text
    except Exception as e:
        dprint(f"[ASR] 本地 Whisper 失败: {e}", flush=True)
        return None
    finally:
        with _ASR_BUSY_LOCK:
            _asr_busy = False


_ASR_CORRECT_FAILS = 0
_ASR_CORRECT_COOLDOWN_UNTIL = 0.0
_ASR_CORRECT_FAIL_LIMIT = 3
_ASR_CORRECT_COOLDOWN_SEC = 180.0


def _asr_correction_cooldown():

    return time.time() < _ASR_CORRECT_COOLDOWN_UNTIL


def _asr_correction_report(ok):

    global _ASR_CORRECT_FAILS, _ASR_CORRECT_COOLDOWN_UNTIL
    if ok:
        _ASR_CORRECT_FAILS = 0
        return
    _ASR_CORRECT_FAILS += 1
    if _ASR_CORRECT_FAILS >= _ASR_CORRECT_FAIL_LIMIT and not _asr_correction_cooldown():
        _ASR_CORRECT_COOLDOWN_UNTIL = time.time() + _ASR_CORRECT_COOLDOWN_SEC
        dprint(f"[ASR] 纠错连续失败 {_ASR_CORRECT_FAILS} 次，"
              f"暂停纠错 {_ASR_CORRECT_COOLDOWN_SEC:.0f}s（把额度让给主对话）", flush=True)


def _run_asr_corrector(text):

    raw = "" if text is None else str(text)
    if not raw.strip():
        return raw
    try:
        if _conv_history_lock is None:
            hist = []
        else:
            with _conv_history_lock:
                hist = list(_conv_history[-6:])
        llm_fn = None if _asr_correction_cooldown() else _llm_correct
        res = asr_corrector.correct_asr_text(raw, history=hist, llm_corrector=llm_fn)
        out = res.get("text") or raw
        if out != raw:
            dprint(f"[ASR纠错] \"{raw[:40]}\" → \"{out[:40]}\"（{res.get('reason','')}）", flush=True)
        return out
    except Exception as e:
        dprint(f"[ASR纠错] 异常回落原文: {e}", flush=True)
        return raw


_CORRECT_MIN_WORDS = 3

_CORRECT_TRIVIAL_RE = re.compile(
    r"^[\s\.,!?;:'\"]*"
    r"(?:hmm+|mm+|uh+|um+|erm+|er+|ah+|eh+|oh+|wow+|hey+|hi+|yo+|"
    r"yeah+|yep+|yup+|nope+|nah+|okay|ok|alright|right|sure|exactly|"
    r"really|indeed|true|great|good|fine|cool|nice|awesome|perfect|"
    r"嗯+|啊+|哦+|呃+|额+|唉+|哈+|嘿+|诶?|噢+|喔+|唔+|"
    r"那个|这个|就是|然后|但是|所以|因为|可能|应该)+"
    r"[\s\.,!?;:'\"]*$",
    re.IGNORECASE,
)


def _worth_correcting(raw_text):

    t = (raw_text or "").strip()
    if not t:
        return False
    words = t.split()
    if len(words) < _CORRECT_MIN_WORDS:
        return False
    if _CORRECT_TRIVIAL_RE.match(t):
        return False
    return True


_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]")


def _has_cjk(text):

    return bool(_CJK_RE.search(str(text or "")))


def _llm_translate_to_english(text, timeout=12.0):

    src = str(text or "").strip()
    if not src or not _has_cjk(src):
        return None
    if not _LLM_KEY:
        return None
    _ok, _why = _upstream_slot(timeout=8.0)
    if not _ok:
        dprint(f"[ASR] 翻译跳过（{_why}），用原文", flush=True)
        return None
    body = {
        "model": _LLM_FAST_MODEL,
        "messages": [
            {"role": "system", "content":
                "You are a translation engine. Translate the user's Chinese (or Japanese/Korean) "
                "sentence into natural, conversational ENGLISH - the way a young woman would say it "
                "out loud in casual chat. Rules: 1) Output ONLY the English translation, nothing "
                "else - no quotes, no notes, no original text. 2) Keep it natural and spoken, not "
                "stiff or textbook. 3) Preserve the meaning and the tone (rude stays rude, "
                "question stays question). 4) If the input is already English, return it unchanged."},
            {"role": "user", "content": src},
        ],
        "max_tokens": 400,
        "stream": False,
    }
    _slot_ok = True
    try:
        req = urllib.request.Request(
            _LLM_UPSTREAM.rstrip("/") + "/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers={"Authorization": f"Bearer {_LLM_KEY}",
                     "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        out = (((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
        if not out:
            return None
        if _has_cjk(out):
            dprint(f"[ASR] 翻译结果仍含中文，放弃（用原文）: {out[:40]}", flush=True)
            return None
        return out
    except Exception as e:
        dprint(f"[ASR] 翻译失败（用原文）: {e}", flush=True)
        return None
    finally:
        if _slot_ok:
            try:
                import agent_bridge as ab
                ab._paced_release()
            except Exception:
                _release_slot()


def _llm_correct(raw_text):

    global _conv_history, _conv_history_lock
    if not ASR_LLM_CORRECT or not _LLM_KEY:
        return raw_text
    if not _worth_correcting(raw_text):
        return raw_text
    if _conv_history_lock is None:
        _conv_history_lock = threading.Lock()
    with _conv_history_lock:
        ctx = list(_conv_history[-6:])
    if not ctx:
        return raw_text
    ctx = ctx[-3:]

    sys_prompt = (
        "You are a speech-recognition post-editor. You get the user's raw transcript (English, "
        "possibly with a few Chinese words) plus the recent conversation. "
        "Your ONLY job: resolve words that are phonetically ambiguous (homophones / near-homophones) "
        "by inferring which one actually makes sense in context. "
        "Examples: 'can you help me' vs a conversation about hearing -> 'can you hear me'; "
        "'there' vs 'their'; names and technical terms you can disambiguate from context. "
        "Rules: 1) Change as few words as possible - usually 1-2 words. "
        "2) If the transcript is already correct, or you are not confident, return it EXACTLY as-is. "
        "Never guess wildly. 3) Do NOT answer the user, translate, explain, or expand. "
        "4) Output ONLY the corrected transcript, nothing else - no quotes, no notes."
    )
    ctx_lines = "\n".join(f"{m.get('role','user')}: {m.get('content','')}" for m in ctx)
    user_msg = (
        f"Recent conversation:\n{ctx_lines}\n\n"
        f"Raw transcript to fix:\n{raw_text}\n\nCorrected transcript:"
    )
    body = {
        "model": _LLM_FAST_MODEL,
        "messages": [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": user_msg},
        ],
        "max_tokens": max(2000, int(len(raw_text.split()) * 3) + 32),
        "stream": False,
    }
    _ok, _why = _upstream_slot(timeout=12.0)
    if not _ok:
        dprint(f"[ASR] 纠错跳过（{_why}），用原文", flush=True)
        return raw_text
    _slot_ok = True
    try:
        req = urllib.request.Request(
            _LLM_UPSTREAM.rstrip("/") + "/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {_LLM_KEY}",
                "Content-Type": "application/json",
            },
        )
        last_err = None
        for attempt in range(2):
            try:
                with urllib.request.urlopen(req, timeout=12) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                break
            except Exception as e:
                last_err = e
                if attempt == 0:
                    continue
                raise last_err
        fixed = (((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
        if fixed and fixed != raw_text:
            _asr_correction_report(True)
            dprint(f"[ASR/correct] '{raw_text}' -> '{fixed}'", flush=True)
            return fixed
        _asr_correction_report(True)
        return raw_text
    except Exception as e:
        _asr_correction_report(False)
        dprint(f"[ASR] 上下文纠错失败(用原文): {e}", flush=True)
        return raw_text
    finally:
        if _slot_ok:
            try:
                import agent_bridge as ab
                ab._paced_release()
            except Exception:
                _release_slot()


def _asr_sensevoice(pcm_f32, cfg):

    try:
        import asr_sensevoice as _sv
        if not _sv.is_ready():
            dprint("[SenseVoice] 模型文件缺失，识别不可用（请放回 model.int8.onnx + tokens.txt）", flush=True)
            return None
        t0 = time.time()
        text, lang = _sv.transcribe(np.asarray(pcm_f32, dtype=np.float32), 16000)
        decode_ms = (time.time() - t0) * 1000
        if not text:
            dprint(f"[SenseVoice] 空结果（{decode_ms:.0f}ms）")
            return None
        dprint(f"[SenseVoice] 识别 {decode_ms:.0f}ms 语种={lang or '?'} → {text[:60]}")
        return text
    except Exception as e:
        dprint(f"[SenseVoice] 识别失败: {e}")
        return None


def _asr_local_engine(pcm_f32, cfg):

    global _asr_busy, _asr_started_at
    engine = (cfg.get("engine") or "sensevoice").lower()
    _asr_started_at = time.time()
    _mark_user_interact()
    try:
        import cognition as _cg
        _cg.user_speaking(True)
    except Exception:
        pass
    try:
        with _ASR_BUSY_LOCK:
            _asr_busy = True
    except Exception:
        _asr_busy = True
    try:
        if engine == "sensevoice":
            return _asr_sensevoice(pcm_f32, cfg)
        return _asr_local_whisper(pcm_f32, cfg)
    finally:
        try:
            with _ASR_BUSY_LOCK:
                _asr_busy = False
        except Exception:
            _asr_busy = False
        try:
            import cognition as _cg
            _cg.user_speaking(False)
        except Exception:
            pass


def asr(pcm_f32):

    cfg = _cfg_asr_online()
    if not cfg:
        cfg = {"enable": True, "provider": "local", "model": "small",
               "language": ASR_LANG_DEFAULT, "correct_with_llm": True}
        dprint("[ASR] asr.online 未配置，回退默认（本地 faster-whisper small + LLM 纠错）", flush=True)
    if not cfg.get("enable", True):
        dprint("[ASR] 未启用，跳过识别", flush=True)
        return (None, None)

    provider = (cfg.get("provider") or "local").lower()
    if provider == "local":
        engine = (cfg.get("engine") or "sensevoice").lower()
        if engine == "sensevoice":
            raw = _asr_sensevoice(pcm_f32, cfg)
        else:
            raw = _asr_local_whisper(pcm_f32, cfg)
        if not raw:
            return (None, None)
        final = _run_asr_corrector(raw)
        if final and final != raw:
            log_chat("原话(ASR)", f"{final}  ⟵ 原识别: {raw}")
        else:
            log_chat("原话(ASR)", final or raw)
        return (raw, final)

    if not cfg.get("api_key"):
        dprint(f"[ASR] 在线识别({provider})缺少 api_key，跳过", flush=True)
        return (None, None)

    model = cfg.get("model") or {
        "siliconflow": "FunAudioLLM/SenseVoiceSmall",
        "groq": "whisper-large-v3",
        "openai": "whisper-1",
    }.get(provider, "whisper-1")

    url = {
        "siliconflow": "https://api.siliconflow.cn/v1/audio/transcriptions",
        "groq": "https://api.groq.com/openai/v1/audio/transcriptions",
        "openai": "https://api.openai.com/v1/audio/transcriptions",
    }.get(provider)
    if not url:
        return (None, None)

    wav = to_wav_bytes(pcm_f32)
    boundary = "----NeuroASRBoundary"
    body = b""
    body += f"--{boundary}\r\n".encode()
    body += b'Content-Disposition: form-data; name="file"; filename="a.wav"\r\n'
    body += b"Content-Type: audio/wav\r\n\r\n"
    body += wav + b"\r\n"
    body += f"--{boundary}\r\n".encode()
    body += b'Content-Disposition: form-data; name="model"\r\n\r\n'
    body += model.encode() + b"\r\n"
    body += f"--{boundary}--\r\n".encode()

    try:
        req = urllib.request.Request(
            url, data=body,
            headers={
                "Authorization": f"Bearer {cfg['api_key']}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        text = (data.get("text") or "").strip()
        text = re.sub(r"<\|[^|]*\|>", "", text).strip()
        dprint(f"[ASR/{provider}] {text}", flush=True)
        return (text, text) if text else (None, None)
    except Exception as e:
        dprint(f"[ASR] 失败({provider}): {e}", flush=True)
        return (None, None)


@app.websocket("/v1/ws/vad")
async def vad(ws: WebSocket):

    await ws.accept()
    MIN_FRAME = int(SR * 0.010)
    speaking = False
    on_ms = 0.0
    off_ms = 0.0
    START_MS = 120.0
    END_MS = 900.0
    HI = 0.060
    LO = 0.040
    try:
        while True:
            raw = await ws.receive_bytes()
            if not raw:
                continue
            chunk = np.frombuffer(raw, dtype=np.float32)
            if chunk.size < MIN_FRAME:
                continue

            frame_ms = chunk.size * 1000.0 / SR
            rms = float(np.sqrt(np.mean(chunk ** 2)) + 1e-9)

            def band_ratio(x, sr, lo, hi):
                w = np.hanning(len(x))
                sp = np.abs(np.fft.rfft(x * w))
                fr = np.fft.rfftfreq(len(x), 1.0 / sr)
                tot = float(sp.sum()) + 1e-9
                return float(sp[(fr >= lo) & (fr < hi)].sum()) / tot

            voice_ratio = band_ratio(chunk, SR, 300.0, 3000.0)
            is_voice = voice_ratio >= 0.08

            loud = rms > (HI if not speaking else LO)
            hit = loud and is_voice
            if hit:
                on_ms += frame_ms
                off_ms = 0.0
            else:
                off_ms += frame_ms
                on_ms = 0.0

            prev = speaking
            if not speaking and on_ms >= START_MS:
                speaking = True
            elif speaking and off_ms >= END_MS:
                speaking = False
            if prev != speaking:
                dprint(f"[VAD] {'人声开始' if speaking else '人声结束'} rms={rms:.4f}", flush=True)
                if speaking:
                    dprint("        ↓ 检测到你在说话，正在录音…", flush=True)
                try:
                    import cognition as _cg
                    _cg.user_voice_active(bool(speaking))
                except Exception:
                    pass

            await ws.send_json({"is_speech": bool(speaking)})
    except Exception:
        pass


@app.get("/warmup")
async def warmup_endpoint():

    try:
        await _warmup_edge_tts()
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.websocket("/v1/asr_stream")
async def asr_stream(websocket: WebSocket):
    await websocket.accept()
    session = stream_asr.StreamSession(sid=uuid.uuid4().hex[:8])
    if not stream_asr.register_session(session):
        await websocket.close(code=1013, reason="too many sessions")
        return
    _STREAM_METRICS["connections"] = _STREAM_METRICS.get("connections", 0) + 1
    if _STREAM_METRICS["connections"] > 1:
        _STREAM_METRICS["reconnects"] = _STREAM_METRICS["connections"] - 1
    _STREAM_METRICS["sessions_peak"] = max(
        _STREAM_METRICS.get("sessions_peak", 0),
        len(getattr(stream_asr, "_sessions", {}) or {}))
    dprint(f"[stream:{session.sid}] 连接建立（持续监听模式，"
          f"静音收尾={stream_asr.END_SILENCE_MS}ms 最短语音={stream_asr.MIN_SPEECH_MS}ms）",
          flush=True)

    _hold = {"text": "", "task": None}

    async def _emit_utterance(text, during_tts):
        await websocket.send_json(
            {"type": "utterance", "text": text, "raw": text,
             "original": text, "during_tts": during_tts})
        dprint(f"[stream:{session.sid}] 回传文本: \"{str(text)[:60]}\"", flush=True)

    async def _flush_hold(reason=""):
        _t = _hold["text"]
        _hold["text"] = ""
        if _hold["task"]:
            try:
                _hold["task"].cancel()
            except Exception:
                pass
            _hold["task"] = None
        if not _t:
            return
        if reason:
            dprint(f"[stream:{session.sid}] [C5] 暂存超时上送({reason}): \"{_t[:40]}\"", flush=True)
        try:
            await _emit_utterance(_t, False)
        except Exception as e:
            dprint(f"[stream:{session.sid}] [C5] 暂存上送失败: {e}", flush=True)

    async def _send_utterance(text, during_tts):
        _hold_ms = _cfg_backend_hold_ms()
        if during_tts or _hold_ms <= 0 or not _looks_unfinished_utterance(text):
            merged = _merge_utterance_text(_hold["text"], text)
            _hold["text"] = ""
            if _hold["task"]:
                try:
                    _hold["task"].cancel()
                except Exception:
                    pass
                _hold["task"] = None
            await _emit_utterance(merged, during_tts)
            return
        _hold["text"] = _merge_utterance_text(_hold["text"], text)
        if _hold["task"]:
            try:
                _hold["task"].cancel()
            except Exception:
                pass
            _hold["task"] = None
        dprint(f"[stream:{session.sid}] [C5] 像没说完，暂存 {_hold_ms}ms: "
               f"\"{_hold['text'][:40]}\"", flush=True)

        async def _later():
            try:
                await asyncio.sleep(_hold_ms / 1000.0)
                await _flush_hold("超时")
            except asyncio.CancelledError:
                pass
            except Exception:
                pass

        _hold["task"] = asyncio.create_task(_later())

    async def _transcribe_and_send(audio):

        try:
            cfg = _cfg_asr_online() or {"model": "small", "language": "en"}

            try:
                import numpy as _np
                _x = _np.asarray(audio, dtype=_np.float32).reshape(-1)
                if _x.size:
                    _rms = float(_np.sqrt(_np.mean(_x * _x)))
                    if _rms < 0.0056:
                        dprint(f"[stream:{session.sid}] [噪声闸] 整段能量过低 "
                               f"rms={_rms:.5f} (< -45dBFS)，丢弃脉冲/稳态噪声", flush=True)
                        return
            except Exception:
                pass

            text = await run_in_threadpool(_asr_local_engine, audio, cfg)
            if not text:
                return
            try:
                _drop, _why = _looks_like_hallucination(text)
                if _drop:
                    dprint(f"[stream:{session.sid}] [噪声闸] 丢弃幻觉文本 "
                           f"\"{str(text)[:40]}\"（{_why}）", flush=True)
                    return
            except Exception as e:
                dprint(f"[stream:{session.sid}] [噪声闸] 判定异常（放行）: {e}", flush=True)
            try:
                _isEcho, _why = _looks_like_echo(text)
                if _isEcho:
                    dprint(f"[stream:{session.sid}] [回环] 疑似她自己的话，丢弃: \"{str(text)[:60]}\""
                           f"（{_why}，对照: \"{str(_LAST_TTS_TEXT.get('raw',''))[:60]}\"）", flush=True)
                    return
            except Exception:
                pass
            try:
                import voiceprint as vp
                _feat = vp.extract_features(audio, 16000)
                if _feat:
                    _is_her, _why = vp.is_her_voice(_feat)
                    if _is_her:
                        dprint(f"[stream:{session.sid}] [音源] 是她自己的声音，丢弃："
                               f"{_why} | 文本=\"{str(text)[:40]}\"", flush=True)
                        return
                    dprint(f"[stream:{session.sid}] [音源] 不是她的声音，放行"
                           f"（{_why}）", flush=True)
            except Exception as e:
                dprint(f"[voiceprint] 判定异常（放行）: {e}", flush=True)

            text = await run_in_threadpool(_run_asr_corrector, text)
            log_chat("原话(ASR)", text)

            during_tts = bool(getattr(session, "_tts", False))
            await _send_utterance(text, during_tts)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            dprint(f"[stream:{session.sid}] 解码/回传失败: {e}", flush=True)

    _frame_q = asyncio.Queue(maxsize=64)

    async def _feed_worker():
        while True:
            try:
                data = await _frame_q.get()
            except asyncio.CancelledError:
                return
            try:
                events = await run_in_threadpool(session.feed, data)
                try:
                    _STREAM_METRICS["buffered_frames"] = _frame_q.qsize()
                except Exception:
                    pass
                for audio in events:
                    _STREAM_METRICS["last_utterance_at"] = time.time()
                    asyncio.create_task(_transcribe_and_send(audio))
            except Exception as e:
                dprint(f"[stream:{session.sid}] 处理帧失败: {e}", flush=True)

    FLUSH_IDLE_S = 1.5

    async def _flush_watchdog():
        while True:
            try:
                await asyncio.sleep(0.5)
                if session._pending_utt is None:
                    continue
                age = time.time() - getattr(session, "_pending_since", 0.0)
                if age < FLUSH_IDLE_S:
                    continue
                pend = await run_in_threadpool(session.flush_pending)
                for audio in pend:
                    _STREAM_METRICS["last_utterance_at"] = time.time()
                    asyncio.create_task(_transcribe_and_send(audio))
            except asyncio.CancelledError:
                return
            except Exception as e:
                dprint(f"[stream:{session.sid}] 收尾定时器异常: {e}", flush=True)

    _feed_task = asyncio.create_task(_feed_worker())
    _flush_task = asyncio.create_task(_flush_watchdog())

    try:
        while True:
            if getattr(session, "_closed", False):
                dprint(f"[stream:{session.sid}] 被新连接驱逐，退出", flush=True)
                break
            msg = await websocket.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            data = msg.get("bytes")
            if data:
                _STREAM_METRICS["last_audio_at"] = time.time()
                _STREAM_METRICS["audio_frames"] = _STREAM_METRICS.get("audio_frames", 0) + 1
                try:
                    _frame_q.put_nowait(data)
                except asyncio.QueueFull:
                    _STREAM_METRICS["dropped_frames"] = _STREAM_METRICS.get("dropped_frames", 0) + 1
                    try:
                        _frame_q.get_nowait()
                        _frame_q.put_nowait(data)
                    except Exception:
                        pass
                continue
            text = msg.get("text")
            if text:
                try:
                    _obj = json.loads(text)
                except Exception:
                    _obj = None
                if isinstance(_obj, dict) and _obj.get("ping"):
                    await websocket.send_json({"type": "pong", "ts": time.time()})
                    continue
                session.handle_control(text)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        dprint(f"[stream:{session.sid}] 连接异常: {e}", flush=True)
    finally:
        try:
            await _flush_hold("连接关闭")
        except Exception:
            pass
        try:
            _feed_task.cancel()
            try:
                _flush_task.cancel()
            except Exception:
                pass
        except Exception:
            pass
        stream_asr.unregister_session(session)
        dprint(f"[stream:{session.sid}] 连接关闭 {session.stats()}", flush=True)


@app.get("/v1/asr_stream_stats")
async def asr_stream_stats():

    return {"sessions": stream_asr.session_stats()}


@app.get("/v1/chat_stream")
async def chat_stream(tail: int = 0):

    global _CHAT_LOOP
    import asyncio as _asyncio
    _CHAT_LOOP = _asyncio.get_running_loop()
    q = _asyncio.Queue(maxsize=500)
    _CHAT_SUBS.add(q)

    async def _gen():
        try:
            for ln in _read_chat_tail(max(0, int(tail or 0))):
                yield "data: " + json.dumps({"line": ln, "ts": time.time()},
                                            ensure_ascii=False) + "\n\n"
            while True:
                try:
                    line = await _asyncio.wait_for(q.get(), timeout=15.0)
                except _asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield "data: " + json.dumps({"line": line, "ts": time.time()},
                                            ensure_ascii=False) + "\n\n"
        finally:
            _CHAT_SUBS.discard(q)

    return StreamingResponse(
        _gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@app.post("/v1/upload_audio")
async def upload_audio(file: UploadFile = File(...)):

    data = await file.read()
    try:
        with wave.open(io.BytesIO(data), "rb") as wf:
            sr = wf.getframerate()
            nframes = wf.getnframes()
            raw = wf.readframes(nframes)
        dur = nframes / float(sr or 16000)
        dprint(f"\n[录音] 收到 {dur:.1f}s 音频，正在识别...", flush=True)
        pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        raw_text, text = await run_in_threadpool(asr, pcm)
        if text:
            return {"status": "success", "text": text, "raw": raw_text or "", "message": ""}
        return {"status": "error", "message": "empty"}
    except Exception as e:
        dprint(f"[backend] upload_audio 出错: {e}")
        return {"status": "error", "message": str(e)}


_tts_warm_at = 0.0
_TTS_WARM_INTERVAL = 300.0


async def _warmup_edge_tts(force=False):

    global _tts_warm_at
    now = time.time()
    if not force and (now - _tts_warm_at) < _TTS_WARM_INTERVAL:
        return
    if _asr_busy:
        dprint("[backend] ASR 识别中，跳过 TTS 预热（避免抢 CPU）", flush=True)
        return
    if getattr(_warmup_edge_tts, "_running", False):
        return
    _warmup_edge_tts._running = True
    t0 = now
    try:
        import edge_tts

        comm = edge_tts.Communicate(".", TTS_VOICE_EN, pitch=TTS_PITCH, rate=TTS_RATE)
        async for _ in comm.stream():
            pass
        _tts_warm_at = time.time()
        dprint(f"[backend] TTS 连接预热完成 ({(time.time()-t0)*1000:.0f}ms)", flush=True)
    except Exception as e:
        dprint(f"[backend] TTS 预热跳过: {e}", flush=True)
    finally:
        _warmup_edge_tts._running = False


_VOICE_PROFILE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                   "..", "memory", "speaker_profile.json")
_VOICE_SIM_THRESHOLD = float(os.environ.get("NEURO_VOICE_SIM", "0.70"))
_VOICE_ENROLL_ACC = {"pcm": [], "dur": 0.0}


def _load_voice_profile():
    try:
        with io.open(_VOICE_PROFILE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _save_voice_profile(prof):
    try:
        d = os.path.dirname(_VOICE_PROFILE_PATH)
        if not os.path.exists(d):
            os.makedirs(d, exist_ok=True)
        with io.open(_VOICE_PROFILE_PATH, "w", encoding="utf-8", newline="") as f:
            f.write(json.dumps(prof, ensure_ascii=False, indent=2))
        return True
    except Exception as e:
        dprint(f"[voiceprint] 保存声纹失败: {e}", flush=True)
        return False


@app.post("/v1/voiceprint/enroll")
async def voiceprint_enroll(request: Request):

    try:
        raw = await request.body()
    except Exception:
        raw = b""
    if not raw:
        return {"ok": False, "msg": "没收到音频"}
    try:
        import voiceprint as vp
        pcm, sr = vp.wav_bytes_to_pcm(raw)
        if pcm is None or pcm.size < sr * 0.5:
            return {"ok": False, "msg": "音频太短或格式不对（要 16bit PCM WAV，≥0.5 秒）"}
        feat = vp.extract_features(pcm, sr)
        if not feat:
            return {"ok": False, "msg": "这段音频没有可用的声纹特征（太轻或不是语音）"}
        prof = {
            "features": feat,
            "sample_rate": sr,
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "threshold": _VOICE_SIM_THRESHOLD,
        }
        _save_voice_profile(prof)
        return {"ok": True, "msg": "声纹已注册", "features": feat}
    except Exception as e:
        return {"ok": False, "msg": f"注册失败: {e}"}


@app.get("/v1/voiceprint/profile")
async def voiceprint_profile():

    prof = _load_voice_profile()
    if not prof:
        return {"ok": True, "registered": False,
                "msg": "还没注册声纹 —— 录 3~5 秒你的声音即可（前端有按钮）"}
    return {"ok": True, "registered": True, "features": prof.get("features"),
            "created_at": prof.get("created_at"),
            "threshold": prof.get("threshold", _VOICE_SIM_THRESHOLD)}


_LAST_TTS_TEXT = {"norm": "", "raw": "", "ts": 0.0}
_TTS_ECHO_WINDOW_S = 15.0
_LAST_TTS_HISTORY = []
_TTS_HISTORY_MAX = 12


def _norm_for_loop(text):

    return "".join(ch for ch in str(text or "").lower() if ch.isalnum())


def _norm_words(text):

    t = str(text or "")
    t = re.sub(r"\[[^\]\]]{0,40}\]", " ", t)
    t = re.sub(r"[^\w\s'-]", " ", t, flags=re.UNICODE)
    return re.sub(r"\s+", " ", t).strip().lower()


def _has_trigram_match(text, ref):

    nw = _norm_words(text).split()
    rw = _norm_words(ref).split()
    if len(nw) < 3 or len(rw) < 3:
        return False
    small, big = (nw, rw) if len(nw) <= len(rw) else (rw, nw)
    for i in range(len(small) - 2):
        tri = " ".join(small[i:i + 3])
        if tri in " ".join(big):
            return True
    return False


def _looks_like_echo(text):

    t = str(text or "").strip()
    if not t:
        return False, ""
    norm = _norm_for_loop(t)
    if len(norm) < 4:
        return False, ""
    history = list(_LAST_TTS_HISTORY or [])
    if not history:
        return False, ""
    now = time.time()
    for last in history:
        if (now - float(last.get("ts") or 0)) > _TTS_ECHO_WINDOW_S:
            continue
        ref = last.get("norm") or ""
        if not ref:
            continue
        if norm and (norm in ref or ref in norm):
            return True, "包含关系"
        if _has_trigram_match(t, last.get("raw") or ""):
            return True, "连续3词逐字命中"
        try:
            import difflib
            r = difflib.SequenceMatcher(None, norm, ref).ratio()
            if r >= 0.62:
                return True, f"相似度 {r:.2f}"
        except Exception:
            pass
    return False, ""


def _record_loop_guard(text):

    try:
        _n = _norm_for_loop(text)
        if len(_n) >= 4:
            _LAST_TTS_TEXT["norm"] = _n
            _LAST_TTS_TEXT["raw"] = str(text)[:120]
            _LAST_TTS_TEXT["ts"] = time.time()
            try:
                _LAST_TTS_HISTORY.insert(0, dict(_LAST_TTS_TEXT))
                if len(_LAST_TTS_HISTORY) > _TTS_HISTORY_MAX:
                    del _LAST_TTS_HISTORY[_TTS_HISTORY_MAX:]
            except Exception:
                pass
    except Exception:
        pass


async def _tts_yield_loop():

    import asyncio
    YIELD_MS = 1.2
    t_wait = time.time()
    yielded = False
    while _asr_busy and (time.time() - t_wait) < YIELD_MS:
        if time.time() - _asr_started_at >= YIELD_MS:
            break
        await asyncio.sleep(0.1)
        yielded = True
    if _asr_busy and yielded:
        dprint(f"[backend] TTS 让路 {YIELD_MS}s 后开始合成（不干等 ASR 全程）", flush=True)
    return (time.time() - t_wait) * 1000, yielded


@app.post("/v3/stream")
async def tts_stream(request: Request, text: str = Query(None)):

    body = {}
    try:
        body = await request.json()
    except Exception:
        body = {}
    if text is None:
        text = (body or {}).get("text", "")
    if not text:
        return Response(content=b"", media_type="audio/mpeg")

    _record_loop_guard(text)

    voice = (body or {}).get("voice") or TTS_VOICE_EN
    pitch = (body or {}).get("pitch") or TTS_PITCH
    rate = (body or {}).get("rate") or TTS_RATE
    volume = (body or {}).get("volume") or TTS_VOLUME

    async def _gen():
        import edge_tts

        await _warmup_edge_tts()
        await _tts_yield_loop()

        t0 = time.time()
        first_ms = None
        total = 0
        buf = bytearray()
        try:
            comm = _make_comm(edge_tts, text, voice, pitch, rate, volume)
            async for ch in comm.stream():
                if ch.get("type") != "audio":
                    continue
                data = ch.get("data") or b""
                if not data:
                    continue
                if first_ms is None:
                    first_ms = (time.time() - t0) * 1000
                total += len(data)
                buf.extend(data)
                yield data
        except Exception as e:
            dprint(f"[tts.stream] 中断: {e}", flush=True)
        finally:
            dprint(f"[tts.latency] (stream) 首块音频={first_ms if first_ms is not None else -1}ms  "
                   f"整段完成={(time.time() - t0) * 1000:.0f}ms  字节={total} 字数={len(text)}",
                   flush=True)
            try:
                if buf:
                    import voiceprint as vp
                    _ok, _f = vp.register_her_voice(bytes(buf))
                    if _ok:
                        dprint(f"[voiceprint] 已登记她的声纹（f0≈{_f.get('f0_median', 0):.0f}Hz）", flush=True)
            except Exception as e:
                dprint(f"[voiceprint] 登记失败（忽略）: {e}", flush=True)

    return StreamingResponse(
        _gen(),
        media_type="audio/mpeg",
        headers={
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/v3")
async def tts(request: Request, text: str = Query(None)):

    body = {}
    try:
        body = await request.json()
    except Exception:
        body = {}
    if text is None:
        text = (body or {}).get("text", "")
    if not text:
        return Response(content=b"", media_type="audio/mpeg")
    _record_loop_guard(text)
    try:
        import asyncio

        import edge_tts

        voice = (body or {}).get("voice") or TTS_VOICE_EN
        pitch = (body or {}).get("pitch") or TTS_PITCH
        rate = (body or {}).get("rate") or TTS_RATE
        volume = (body or {}).get("volume") or TTS_VOLUME

        await _warmup_edge_tts()

        _tts_wait_ms, _yielded = await _tts_yield_loop()

        _t_synth0 = time.time()

        comm = _make_comm(edge_tts, text, voice, pitch, rate, volume)
        buf = b""
        loop = asyncio.get_event_loop()
        queue = asyncio.Queue()
        _first_chunk_ms = None

        async def feed():
            nonlocal _first_chunk_ms
            async for ch in comm.stream():
                if ch["type"] == "audio":
                    if _first_chunk_ms is None:
                        _first_chunk_ms = (time.time() - _t_synth0) * 1000
                    await queue.put(ch["data"])
            await queue.put(None)

        task = loop.create_task(feed())
        while True:
            item = await queue.get()
            if item is None:
                break
            buf += item
        await task
        dprint(f"[tts.latency] 让路等待={_tts_wait_ms:.0f}ms  首块音频={_first_chunk_ms:.0f}ms  "
              f"整段完成={(time.time() - _t_synth0)*1000:.0f}ms  字节={len(buf)}  "
              f"字数={len(text)}", flush=True)
        try:
            import voiceprint as vp
            _ok, _f = vp.register_her_voice(bytes(buf))
            if _ok:
                dprint(f"[voiceprint] 已登记她的声纹（f0≈{_f.get('f0_median', 0):.0f}Hz）", flush=True)
        except Exception as e:
            dprint(f"[voiceprint] 登记她的声纹失败（忽略）: {e}", flush=True)
        return Response(content=buf, media_type="audio/mpeg")
    except Exception as e:
        dprint(f"[backend] TTS 出错: {e}")
        return Response(content=b"", media_type="audio/mpeg")


_FILLER = {
    "你好", "在吗", "嗯", "哦", "谢谢", "好的", "行", "可以", "收到", "了解",
    "知道了", "没事", "再见", "拜拜", "晚安", "早安", "哈哈", "嗯嗯", "啊",
}


@app.post("/v5/check")
async def memory_check(text: str = Query("")):

    t = (text or "").strip()
    if len(t) < 5 or t in _FILLER:
        return {"需要检索": "否"}
    if not any(ch.isalnum() for ch in t):
        return {"需要检索": "否"}
    return {"需要检索": "是"}


@app.post("/v4/emotion")
async def ai_emotion(request: Request):

    try:
        payload = await request.json()
    except Exception:
        payload = {}
    text = (payload or {}).get("text") or ""
    if not isinstance(text, str) or not text.strip() or len(text) > 2000:
        return {"emotions": []}
    try:
        import agent_bridge as ab
        seq = await run_in_threadpool(ab.ai_judge_emotions, text[:2000])
    except Exception as e:
        dprint(f"[backend] AI 情绪判断异常（忽略）: {e}", flush=True)
        seq = []
    return {"emotions": seq}


_COMPLETE_SYSTEM = (
    "You judge whether a spoken sentence is grammatically and semantically COMPLETE — "
    "i.e. whether the speaker has finished expressing that thought, so it is time to respond.\n"
    "Ignore punctuation entirely. Do NOT treat a trailing comma/period as proof of completion. "
    "Judge by MEANING.\n\n"
    "Answer '是' (complete) only if the thought stands on its own as a finished thought. "
    "Answer '否' (incomplete) if the speaker is mid-thought and likely continues.\n\n"
    "INCOMPLETE (答否) examples:\n"
    "  - '我今天天气，嗯。'          -> weather is mentioned but never described; incomplete\n"
    "  - '我今天天气'                -> missing the predicate/predicate complement\n"
    "  - '然后我去了那个'            -> dangling demonstrative, noun phrase unfinished\n"
    "  - 'because I wanted to'-> subordinate clause with no main clause\n"
    "  - 'so what I mean is that I'-> trailing 'I' awaits a verb\n"
    "  - '帮我看一下这个'            -> could continue with '这个bug' / '这个错误'; "
    "if the demonstrative has no referent yet, treat as incomplete\n"
    "  - '嗯' '那个' '就是'          -> pure filler, clearly incomplete\n\n"
    "COMPLETE (答是) examples:\n"
    "  - '我今天天气很好。'\n"
    "  - '帮我查一下我今天的天气。'\n"
    "  - 'what is the meaning of life'\n"
    "  - 'are you a robot'\n"
    "  - 'I want you to write a C++ rocket engine design'\n"
    "  - '2+2等于多少'-> self-contained even without punctuation\n\n"
    "Note: many complete spoken sentences lack terminal punctuation. Many incomplete ones "
    "have it. Meaning decides, not marks.\n"
    "Output ONLY '是' or '否'."
)


def _sentence_complete(text):

    text = (text or "").strip()
    if not text:
        return True
    if not _LLM_KEY:
        return True

    if len(text) <= 2:
        return False
    if re.fullmatch(r"[\s嗯啊呃哦噢唉哈嘿额那个这个就是然后呢吧嘛呀哦噢]+", text):
        return False
    if _asr_correction_cooldown():
        dprint("[sentence/complete] 上游限流中，跳过语义判断（直接当说完）", flush=True)
        return True

    body = {
        "model": _LLM_FAST_MODEL,
        "messages": [
            {"role": "system", "content": _COMPLETE_SYSTEM},
            {"role": "user", "content": f"Spoken text: {text}"},
        ],
        "max_tokens": 2000,
        "stream": False,
    }
    _s_ok, _s_why = _upstream_slot(timeout=3.0)
    if not _s_ok:
        dprint(f"[sentence/complete] 拿不到上游名额（{_s_why}），直接当说完", flush=True)
        return True
    try:
        last_err = None
        for attempt in range(1):
            try:
                req = urllib.request.Request(
                    _LLM_UPSTREAM.rstrip("/") + "/chat/completions",
                    data=json.dumps(body).encode("utf-8"),
                    headers={
                        "Authorization": f"Bearer {_LLM_KEY}",
                        "Content-Type": "application/json",
                    },
                )
                with urllib.request.urlopen(req, timeout=6) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                ans = (((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
                if not ans:
                    raise RuntimeError("empty content (reasoning consumed budget)")
                done = not ans.startswith("否")
                dprint(f"[sentence/complete] '{text}' -> {ans} (说完={done})", flush=True)
                return done
            except Exception as e:
                last_err = e
                if attempt < 2:
                    wait_s = 1.5 * (attempt + 1) ** 2
                    dprint(f"[sentence/complete] 第{attempt+1}次失败({e})，{wait_s:.1f}s 后重试", flush=True)
                    time.sleep(wait_s)
        dprint(f"[sentence/complete] 重试耗尽，降级为已说完: {last_err}", flush=True)
        return True
    except Exception as e:
        dprint(f"[sentence/complete] 判断失败(降级为已说完): {e}", flush=True)
        return True
    finally:
        try:
            import agent_bridge as ab
            ab._paced_release()
        except Exception:
            _release_slot()


@app.post("/v6/complete")
async def sentence_complete(text: str = Query("")):

    done = _sentence_complete(text)
    return {"说完": done}


def _text_of(content):

    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [item.get("text", "") for item in content
                 if isinstance(item, dict) and item.get("type") == "text"]
        return "\n".join(p for p in parts if p)
    return ""


import memory_system


def _extract_latest_user_text(messages):

    if not messages:
        return ""
    for m in reversed(messages):
        if m.get("role") == "user":
            c = m.get("content")
            if isinstance(c, str):
                return c
            if isinstance(c, list):
                for part in c:
                    if isinstance(part, dict) and part.get("type") == "text":
                        return part.get("text", "")
    return ""


def inject_memory(messages, mode="chat"):

    if not messages:
        return
    si = next((i for i, m in enumerate(messages) if m.get("role") == "system"), None)
    if si is None:
        messages.insert(0, {"role": "system", "content": ""})
        si = 0
    sysmsg = messages[si]
    content = str(sysmsg.get("content") or "")

    try:
        if "【Resident】" not in content:
            content = (content + "\n\n" + memory_system.resident_prompt()).strip()

        if mode == "opening":
            sysmsg["content"] = content
            return

        if "【Recollection】" not in content:
            if mode == "proactive":
                hint = memory_system.proactive_hint()
                if hint:
                    content = (content + "\n\n" + hint).strip()
            else:
                user_text = _extract_latest_user_text(messages)
                force = memory_system.is_force_recall(user_text)
                recall = memory_system.recall_context(user_text, force=force)
                if recall:
                    content = (content + "\n\n" + recall).strip()

        sysmsg["content"] = content
    except Exception as e:
        dprint(f"[memory] 注入失败（忽略）: {e}", flush=True)


@app.post("/v1/memory/session_end")
async def memory_session_end(request: Request):

    try:
        body = await request.json()
        msgs = (body or {}).get("messages") or []
    except Exception:
        msgs = []
    try:
        _res = await run_in_threadpool(memory_system.session_end, msgs)
        added, kept, removed = _res[0], _res[1], _res[2]
        added_texts = _res[3] if len(_res) > 3 else []
        return {"status": "success", "added": added, "kept": kept,
                "removed": removed, "added_texts": added_texts}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.get("/v1/memory/proactive")
async def memory_proactive():

    try:
        resident = memory_system.resident_prompt()
        hint = memory_system.proactive_hint()
        block = (resident + "\n\n" + hint).strip() if hint else resident
        return {"status": "success", "context": block}
    except Exception as e:
        return {"status": "error", "message": str(e)}


_STREAM_METRICS = {
    "last_audio_at": 0.0,
    "audio_frames": 0,
    "dropped_frames": 0,
    "buffered_frames": 0,
    "queue_capacity": 64,
    "connections": 0,
    "reconnects": 0,
    "last_utterance_at": 0.0,
    "sessions_peak": 0,
}


@app.get("/v1/user/name")
async def user_name_get():

    return {"name": _user_name(), "asked": _user_asked()}


@app.post("/v1/user/name")
async def user_name_set(req: dict | None = None):

    name = ""
    if isinstance(req, dict):
        name = str(req.get("name") or "")
    ok = _set_user_name(name)
    return {"ok": ok, "name": _user_name()}


@app.get("/v1/health")
async def health():

    return {
        "ok": True,
        "ts": time.time(),
        "sessions": len(getattr(stream_asr, "_sessions", {}) or {}),
        "asr_busy": bool(getattr(stream_asr, "_asr_busy", False)),
        "note": "backend process alive; audio stream health is /v1/stream-health",
    }


@app.get("/v1/stream-health")
async def stream_health():

    m = _STREAM_METRICS
    now = time.time()
    last_audio = float(m.get("last_audio_at") or 0.0)
    silence_for = round(now - last_audio, 1) if last_audio else None
    return {
        "ok": True,
        "ts": now,
        "last_audio_at": last_audio or None,
        "silence_for_s": silence_for,
        "audio_frames": m.get("audio_frames", 0),
        "dropped_frames": m.get("dropped_frames", 0),
        "buffered_frames": m.get("buffered_frames", 0),
        "queue_capacity": m.get("queue_capacity", 64),
        "connections": m.get("connections", 0),
        "reconnects": m.get("reconnects", 0),
        "last_utterance_at": m.get("last_utterance_at") or None,
        "sessions_now": len(getattr(stream_asr, "_sessions", {}) or {}),
        "sessions_peak": m.get("sessions_peak", 0),
        "chat_subscribers": len(_CHAT_SUBS),
    }


_VISION_MANAGER = None
_VISION_SPEECH_QUEUE: list = []


def _get_vision_manager():

    global _VISION_MANAGER
    if _VISION_MANAGER is None:
        try:
            import vision_manager as vm
            _VISION_MANAGER = vm.VisionManager(
                on_speech=_vision_on_speech,
                on_status=_vision_on_status,
            )
        except Exception as e:
            dprint(f"[vision] 管理器加载失败: {e}", flush=True)
            _VISION_MANAGER = False
    return _VISION_MANAGER or None


def _vision_on_status(evt: dict):

    dprint(f"[vision] {evt.get('state')}"
           + (f" code={evt.get('code')}" if evt.get("code") else "")
           + (f" msg={str(evt.get('message'))[:120]}" if evt.get("message") else ""),
           flush=True)


def _vision_on_speech(observation: str, meta: dict):

    try:
        import agent_bridge as _ab_cfg
        _speak_ok = bool(_ab_cfg.load_cfg().get("vision", {}).get("free", {}).get("speak_enabled", False))
    except Exception:
        _speak_ok = False
    if not _speak_ok:
        dprint(f"[vision] 视图侧闭嘴（speak_enabled=false）：观察仅进上下文，不开口。"
               f"{observation[:60]}", flush=True)
        return
    _VISION_SPEECH_QUEUE.append({"text": observation, "meta": meta, "at": time.time()})
    while len(_VISION_SPEECH_QUEUE) > 8:
        _VISION_SPEECH_QUEUE.pop(0)
    dprint(f"[vision] 收到观察（队列 {len(_VISION_SPEECH_QUEUE)}）: "
           f"{observation[:80]}", flush=True)


_VISION_LAST_SPEAK_TS = 0.0


_IDLE_LAST_USER_TS = 0.0
_IDLE_LAST_SPEAK_TS = 0.0
_IDLE_LAST_SPEAK_TEXT = ""
_IDLE_PROCESS_START_TS = time.time()
_IDLE_COLD_SPOKE = False


def _mark_user_interact():

    global _IDLE_LAST_USER_TS
    _IDLE_LAST_USER_TS = time.time()
    try:
        import cognition as _cg
        _cg.user_input()
    except Exception:
        pass

_VISION_SPEAK_BUDGET = {"window_start": 0.0, "count": 0}


def _vision_speak_budget_ok(cap: int, commit: bool = False) -> bool:

    now = time.time()
    b = _VISION_SPEAK_BUDGET
    try:
        cap = max(1, int(cap))
    except Exception:
        cap = 8
    if now - float(b.get("window_start") or 0.0) >= 3600.0:
        b["window_start"] = now
        b["count"] = 0
    if commit:
        b["count"] = int(b.get("count") or 0) + 1
        return True
    return int(b.get("count") or 0) < cap
_FE_TTS_PLAYING = False
_FE_TTS_LAST_END_AT = 0.0
_VISION_POST_SPEECH_QUIET_S = 8.0
_VISION_LAST_SPOKEN = ""


async def _vision_speech_worker():

    global _VISION_LAST_SPEAK_TS
    while True:
        try:
            await asyncio.sleep(0.4)
            if not _VISION_SPEECH_QUEUE:
                continue
            try:
                import agent_bridge as _ab_cfg
                _speak_ok = bool(_ab_cfg.load_cfg().get("vision", {}).get("free", {}).get("speak_enabled", False))
            except Exception:
                _speak_ok = False
            if not _speak_ok:
                _VISION_SPEECH_QUEUE.clear()
                dprint("[vision] 视图侧闭嘴：存量好奇队列已清空", flush=True)
                continue
            item = _VISION_SPEECH_QUEUE.pop(0)
            obs = item.get("text") or ""
            if not obs:
                continue

            try:
                import arbiter as _arb
                _vd = _arb.decide("vision", text=obs, source="vision")
                if _vd["action"] != "speak":
                    try:
                        import vision_manager as _vm_age
                        _max_age = _vm_age._speak_max_age_s()
                    except Exception:
                        _max_age = 20.0
                    _age = time.time() - float(item.get("at") or 0)
                    if _age > _max_age:
                        dprint(f"[vision] 观察已过期 {_age:.0f}s > {_max_age:.0f}s，丢弃"
                               f"（arbiter: {_vd['action']}）", flush=True)
                    else:
                        _VISION_SPEECH_QUEUE.insert(0, item)
                        dprint(f"[vision] arbiter 拒绝: {_vd['action']} / {_vd['reason']}",
                               flush=True)
                    continue
            except Exception as _e:
                dprint(f"[vision] 裁决异常（保守延后）: {_e}", flush=True)
                _VISION_SPEECH_QUEUE.insert(0, item)
                continue

            try:
                import vision_manager as _vm
                if time.time() - float(item.get("at") or 0) > _vm._speak_max_age_s():
                    dprint("[vision] 观察已过期，丢弃", flush=True)
                    continue
            except Exception:
                pass


            try:
                import vision_persona as vp
                cfg = __import__("agent_bridge").load_cfg()
                obs_list = [obs]
                try:
                    mgr = _get_vision_manager()
                    if mgr:
                        recent = mgr.recent_observations(window_s=60.0)
                        if recent:
                            obs_list = recent
                except Exception:
                    pass
                base = []
                try:
                    import memory_system as ms
                    ctx = ms.resident_prompt()
                    hint = ms.proactive_hint()
                    if hint:
                        ctx = (ctx + "\n\n" + hint).strip()
                    base.append({"role": "system", "content": ctx})
                except Exception:
                    pass
                sysp = (cfg.get("llm") or {}).get("system_prompt") or ""
                sysp = _apply_user_name(sysp)
                if sysp:
                    base.insert(0, {"role": "system", "content": sysp})

                line = await asyncio.to_thread(
                    vp.speak_from_observation, cfg, base, obs_list, max_tokens=300)
            except Exception as e:
                dprint(f"[vision] 转人设回答失败: {e}", flush=True)
                line = ""

            if not line:
                continue
            dprint(f"[vision] 人设化回答: {line[:100]}", flush=True)

            global _VISION_LAST_SPOKEN
            _dup_sources = [_VISION_LAST_SPOKEN]
            try:
                import cognition as _cg
                _pa_ts, _pa_text = _cg.last_proactive_info()
                if _pa_text:
                    _dup_sources.append(_pa_text)
            except Exception:
                pass
            _dropped_dup = False
            for _prev_text in _dup_sources:
                if not _prev_text:
                    continue
                _prev = set(_prev_text.lower().split())
                _cur = set(line.lower().split())
                if _prev and _cur:
                    _inter = len(_prev & _cur)
                    _union = len(_prev | _cur)
                    if _inter / _union >= 0.6:
                        dprint("[vision] 台词与上次雷同，闭嘴跳过",
                               flush=True)
                        _dropped_dup = True
                        break
            if _dropped_dup:
                continue
            _VISION_LAST_SPOKEN = line

            _VISION_LAST_SPEAK_TS = time.time()
            try:
                import arbiter as _arb2
                _ok2, _why2 = _arb2.commit(_vd.get("token"))
                if not _ok2:
                    dprint(f"[vision] 复查未通过，丢弃: {_why2}", flush=True)
                    continue
            except Exception as _e:
                dprint(f"[vision] 复查异常（保守丢弃）: {_e}", flush=True)
                continue
            try:
                await _broadcast_vision_speak(line, item.get("meta") or {})
            except Exception as e:
                dprint(f"[vision] 推送失败: {e}", flush=True)
        except asyncio.CancelledError:
            return
        except Exception as e:
            dprint(f"[vision] worker 异常: {e}", flush=True)


_VISION_SPEAK_SOCKETS: list = []


async def _broadcast_vision_speak(line: str, meta: dict):

    log_chat("她说(识图)", line)
    payload = {"type": "vision_speak", "text": line, "meta": meta}
    dead = []
    for ws in list(_VISION_SPEAK_SOCKETS):
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        try:
            _VISION_SPEAK_SOCKETS.remove(ws)
        except Exception:
            pass


_IDLE_WORKER_TASK = None


async def _idle_worker():

    global _IDLE_LAST_SPEAK_TS, _IDLE_LAST_SPEAK_TEXT, _IDLE_COLD_SPOKE
    while True:
        try:
            await asyncio.sleep(5.0)
            try:
                import arbiter as _arb
                _vd = _arb.decide("idle", text="", source="idle")
                if _vd["action"] != "speak":
                    continue
            except Exception as _e:
                dprint(f"[idle] 裁决异常（保守跳过）: {_e}", flush=True)
                continue

            _idle_cfg = {}
            try:
                _idle_cfg = (_load_cfg_dict().get("idle") or {})
            except Exception:
                pass
            try:
                idle_after = float(_idle_cfg.get("speak_after_s", 20.0))
            except Exception:
                idle_after = 20.0
            try:
                cold_after = float(_idle_cfg.get("cold_start_after_s", 120.0))
            except Exception:
                cold_after = 120.0
            now = time.time()
            try:
                import cognition as _cg
                _last_user_ts = _cg.snapshot().get("last_user_ts", 0.0)
            except Exception:
                continue
            if _last_user_ts <= 0:
                if cold_after <= 0 or _IDLE_COLD_SPOKE:
                    continue
                if now - _IDLE_PROCESS_START_TS < cold_after:
                    continue
            elif now - _last_user_ts < idle_after:
                continue

            try:
                respeak = float((_load_cfg_dict().get("idle") or {}).get("respeak_s", 45.0))
            except Exception:
                respeak = 45.0
            if _IDLE_LAST_SPEAK_TS > 0 and now - _IDLE_LAST_SPEAK_TS < respeak:
                continue


            line = await _gen_idle_line()
            if not line:
                continue

            _dup_prev = _IDLE_LAST_SPEAK_TEXT
            try:
                import cognition as _cg
                _pa_ts, _pa_text = _cg.last_proactive_info()
                if _pa_text and not _dup_prev:
                    _dup_prev = _pa_text
            except Exception:
                pass
            if _dup_prev:
                _prev = set(_dup_prev.lower().split())
                _cur = set(line.lower().split())
                if _prev and _cur:
                    _inter = len(_prev & _cur)
                    _union = len(_prev | _cur)
                    if _union and _inter / _union >= 0.6:
                        continue
            _IDLE_LAST_SPEAK_TEXT = line
            _IDLE_LAST_SPEAK_TS = now
            try:
                import arbiter as _arb2
                _ok2, _why2 = _arb2.commit(_vd.get("token"))
                if not _ok2:
                    dprint(f"[idle] 复查未通过，丢弃: {_why2}", flush=True)
                    continue
            except Exception as _e:
                dprint(f"[idle] 复查异常（保守丢弃）: {_e}", flush=True)
                continue
            dprint(f"[idle] 空闲搭话: {line[:80]}", flush=True)
            try:
                await _broadcast_vision_speak(line, {"source": "idle"})
                _IDLE_COLD_SPOKE = True
            except Exception as e:
                dprint(f"[idle] 搭话推送失败: {e}", flush=True)
        except asyncio.CancelledError:
            return
        except Exception as e:
            dprint(f"[idle] worker 异常: {e}", flush=True)


async def _gen_idle_line() -> str:

    try:
        import vision_persona as vp
        import agent_bridge as _ab
        import memory_system as _ms
        cfg = _ab.load_cfg()
        base = []
        try:
            ctx = _ms.resident_prompt()
            hint = _ms.proactive_hint()
            if hint:
                ctx = (ctx + "\n\n" + hint).strip()
            base.append({"role": "system", "content": ctx})
        except Exception:
            pass
        sysp = (cfg.get("llm") or {}).get("system_prompt") or ""
        sysp = _apply_user_name(sysp)
        if sysp:
            base.insert(0, {"role": "system", "content": sysp})

        obs_list = []
        try:
            mgr = _get_vision_manager()
            if mgr:
                try:
                    _fresh_s = float((_load_cfg_dict().get("idle") or {})
                                     .get("observation_max_age_s", 20.0))
                except Exception:
                    _fresh_s = 20.0
                recent = mgr.recent_observations(window_s=_fresh_s)
                if recent:
                    obs_list = recent
        except Exception:
            pass

        if not obs_list:
            hint2 = ""
            try:
                if hasattr(_ms, "idle_hint"):
                    hint2 = _ms.idle_hint()
                else:
                    hint2 = _ms.proactive_hint()
            except Exception:
                hint2 = ""
            try:
                _p = [m for m in base if m.get("role") == "system"]
                _p.append({"role": "user", "content":
                    ("It has been quiet for a while (he may be away or just idle). "
                     "Use the memory hint above if there is one. If there is none, "
                     "just start a SHORT line in your own voice — wonder aloud, ask "
                     "him something small, or mutter about what you are doing. "
                     "One or two sentences only, never recite any memory verbatim.")
                    + ("\n\n[Mood/memory hint]\n" + hint2 if hint2 else "")})
                line = await asyncio.to_thread(
                    _ab.llm_complete, cfg, _p, max_tokens_override=120)
                line = _ab.strip_cjk_for_speech(_ab.strip_emotion_tags(line or "")).strip()
                if not line or line.lower().startswith("silent"):
                    return ""
                return line
            except Exception:
                return ""
        line = await asyncio.to_thread(
            vp.speak_from_observation, cfg, base, obs_list, max_tokens=300)
        return line
    except Exception:
        return ""
_VISION_FRAME_START_RETRY_AT = 0.0


@app.post("/v1/vision_frame")
async def vision_frame(request: Request):

    global _VISION_FRAME_START_RETRY_AT
    try:
        data = await request.body()
    except Exception as e:
        return {"ok": False, "active": False, "reason": "read_failed", "detail": str(e)}
    if not data:
        return {"ok": False, "active": False, "reason": "empty_frame"}

    mgr = _get_vision_manager()
    if not mgr:
        return {"ok": False, "active": False, "reason": "manager_unavailable"}

    if not mgr.active:
        now = time.time()
        if now - _VISION_FRAME_START_RETRY_AT >= 5.0:
            _VISION_FRAME_START_RETRY_AT = now
            try:
                if await mgr.start():
                    mgr.mark_start()
                    dprint("[vision] 检测到 Key 已配置，连续注视自动接管", flush=True)
            except Exception as e:
                dprint(f"[vision] 激活失败: {e}", flush=True)

    try:
        accepted = await mgr.push_frame(data)
    except Exception as e:
        return {"ok": False, "active": mgr.active, "reason": "push_failed", "detail": str(e)}

    if accepted:
        global _MIND_VIS_LAST_TS
        _now_v = time.time()
        if _now_v - _MIND_VIS_LAST_TS >= 2.0:
            _MIND_VIS_LAST_TS = _now_v
            try:
                import arbiter as _arb
                _arb.on_visual_change(0.5)
            except Exception:
                pass

    return {
        "ok": True,
        "accepted": bool(accepted),
        "active": mgr.active,
        "frames": mgr._frame_seq,
        "observations": len(mgr.observations),
        "reason": "" if mgr.active else "no key / disabled",
    }


_MIND_VIS_LAST_TS = 0.0
_BRAIN_VIZ_CACHE = None
_BRAIN_3D_CACHE = None


@app.post("/v1/mind/event")
async def mind_event(payload: dict = None):

    p = payload or {}
    kind = str(p.get("kind") or "").lower()
    amp = float(p.get("amp", 0.5) or 0.5)
    try:
        import arbiter as _arb
    except Exception as e:
        return {"ok": False, "reason": f"arbiter_unavailable:{e}"}
    if kind == "interrupt":
        _arb.on_interrupt()
    elif kind == "praise":
        _arb.on_praise()
    elif kind == "vision":
        _arb.on_visual_change(amp)
    elif kind in ("touch", "audio"):
        import drive_client as _dc
        _dc.get_drive_client().stimulate(kind, amp)
    else:
        return {"ok": False, "reason": f"unknown_kind:{kind}"}
    return {"ok": True, "kind": kind}


@app.get("/v1/brain/viz")
async def brain_viz(since: int = 0):

    global _BRAIN_VIZ_CACHE
    now = time.time()
    key = int(since or 0)
    c = _BRAIN_VIZ_CACHE
    if c and c.get("since") == key and (now - c.get("at", 0)) < 0.1:
        return c["payload"]
    try:
        import json as _json
        import urllib.request as _ureq

        def _fetch(since_f: int):
            url = f"http://127.0.0.1:6007/viz?since={since_f}"
            with _ureq.urlopen(url, timeout=0.6) as r:
                return _json.loads(r.read().decode("utf-8"))

        payload = await run_in_threadpool(_fetch, key)
        _BRAIN_VIZ_CACHE = {"since": payload.get("frame", key), "at": now, "payload": payload}
        return payload
    except Exception as e:
        return {"v": 1, "ok": False, "reason": f"bridge_unavailable:{e}", "frames": []}


@app.get("/v1/brain/3d/points")
async def brain_3d_points():

    def _fetch():
        import urllib.request as _ureq
        with _ureq.urlopen("http://127.0.0.1:6007/viz3d/points", timeout=3.0) as r:
            return r.read()

    try:
        blob = await run_in_threadpool(_fetch)
        return Response(content=blob, media_type="application/octet-stream",
                        headers={"Cache-Control": "no-store"})
    except Exception as e:
        from fastapi.responses import JSONResponse
        return JSONResponse({"ok": False, "reason": f"bridge_unavailable:{e}"}, status_code=503)


@app.get("/v1/brain/3d/spikes")
async def brain_3d_spikes(since: int = 0):

    global _BRAIN_3D_CACHE
    now = time.time()
    key = int(since or 0)
    c = _BRAIN_3D_CACHE
    if c and c.get("since") == key and (now - c.get("at", 0)) < 0.1:
        return c["payload"]

    def _fetch(since_f: int):
        import json as _json
        import urllib.request as _ureq
        url = f"http://127.0.0.1:6007/viz3d/spikes?since={since_f}"
        with _ureq.urlopen(url, timeout=0.8) as r:
            return _json.loads(r.read().decode("utf-8"))

    try:
        payload = await run_in_threadpool(_fetch, key)
        _BRAIN_3D_CACHE = {"since": payload.get("frame", key), "at": now, "payload": payload}
        return payload
    except Exception as e:
        return {"v": 1, "ok": False, "reason": f"bridge_unavailable:{e}", "frames": []}


@app.post("/v1/bridge/stop")
async def bridge_stop():

    try:
        import asyncio as _aio
        await run_in_threadpool(_bridge_stop)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "reason": str(e)}


@app.get("/v1/mind/status")
async def mind_status():

    try:
        import arbiter as _arb
        managed = bool(_BRIDGE_PROC is not None and _BRIDGE_PROC.poll() is None)
        payload = {"ok": True, **_arb.status(), "emotion": _arb.emotion(),
                   "bridge_managed": managed}
        try:
            import intent as _intent
            _cur = _intent.current()
            payload["intent"] = (_cur.get("type") if isinstance(_cur, dict) else None)
        except Exception:
            payload["intent"] = None
        return _sanitize_json(payload)
    except Exception as e:
        return {"ok": False, "reason": str(e)}


@app.get("/v1/vision/status")
async def vision_status():

    mgr = _get_vision_manager()
    if not mgr:
        return {"ok": True, "enabled": False, "reason": "manager_unavailable"}
    return {"ok": True, **mgr.status()}


@app.post("/v1/vision/start")
async def vision_start():

    mgr = _get_vision_manager()
    if not mgr:
        return {"ok": False, "reason": "manager_unavailable"}
    ok = await mgr.start()
    return {"ok": ok, **mgr.status()}


@app.post("/v1/vision/stop")
async def vision_stop():

    mgr = _get_vision_manager()
    if not mgr:
        return {"ok": True}
    await mgr.stop()
    return {"ok": True, **mgr.status()}


@app.post("/v1/vision/ask")
async def vision_ask(payload: dict = None):

    mgr = _get_vision_manager()
    if not mgr:
        return {"ok": False, "reason": "manager_unavailable"}
    q = (payload or {}).get("question") or "What is on the screen?"
    text = await mgr.ask(q)
    return {"ok": bool(text), "text": text, **mgr.status()}


@app.post("/v1/vision/verify")
async def vision_verify(payload: dict = None):

    mgr = _get_vision_manager()
    if not mgr:
        return {"ok": False, "reason": "manager_unavailable"}
    if (payload or {}).get("ime"):
        return await mgr.verify_ime()
    x = (payload or {}).get("x")
    y = (payload or {}).get("y")
    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        return {"ok": False, "reason": "bad_coord", "x": x, "y": y}
    return await mgr.verify_cursor(int(x), int(y))


@app.get("/v1/vision/observations")
async def vision_observations():

    mgr = _get_vision_manager()
    if not mgr:
        return {"ok": True, "observations": []}
    return {"ok": True,
            "observations": [o.to_dict() for o in mgr.observations],
            "context": mgr.observation_context()}


@app.websocket("/v1/vision_frames")
async def vision_frames(websocket: WebSocket):

    await websocket.accept()
    mgr = _get_vision_manager()
    if not mgr:
        await websocket.send_json({"type": "status", "state": "unavailable"})
        await websocket.close(code=1011, reason="vision manager unavailable")
        return

    if not mgr.active:
        started = await mgr.start()
        if not started:
            await websocket.send_json({"type": "status", "state": "not_started",
                                       "detail": mgr.status()})
        else:
            mgr.mark_start()

    frames = 0
    last_report = 0.0
    _vision_start_retry_at = 0.0
    try:
        while True:
            msg = await websocket.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            text = msg.get("text")
            if text:
                try:
                    obj = json.loads(text)
                except Exception:
                    obj = {}
                if isinstance(obj, dict) and obj.get("type") == "hello":
                    await websocket.send_json({
                        "type": "status", "state": "ready",
                        "enabled": mgr.enabled, "fps": mgr.fps,
                        "autopush": mgr.autopush,
                    })
                continue

            data = msg.get("bytes")
            if not data:
                continue
            frames += 1

            if not mgr.active:
                now = time.time()
                if now - _vision_start_retry_at >= 5.0:
                    _vision_start_retry_at = now
                    if await mgr.start():
                        mgr.mark_start()
                        dprint("[vision] 检测到 Key 已配置，连续注视已自动接管", flush=True)

            ok = await mgr.push_frame(data)
            now = time.time()
            if now - last_report >= 10:
                last_report = now
                try:
                    await websocket.send_json({
                        "type": "status", "state": "streaming",
                        "frames": frames, "sent": mgr._frame_seq,
                        "last_ok": ok, "active": mgr.active,
                    })
                except Exception:
                    pass
    except WebSocketDisconnect:
        pass
    except Exception as e:
        dprint(f"[vision] 帧连接异常: {e}", flush=True)
    finally:
        dprint(f"[vision] 帧连接结束（共 {frames} 帧）", flush=True)


@app.websocket("/v1/vision_speak")
async def vision_speak_ws(websocket: WebSocket):

    await websocket.accept()
    _VISION_SPEAK_SOCKETS.append(websocket)
    try:
        while True:
            msg = await websocket.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            text = msg.get("text")
            if text:
                try:
                    obj = json.loads(text)
                except Exception:
                    obj = {}
                if isinstance(obj, dict):
                    if obj.get("type") == "ping":
                        await websocket.send_json({"type": "pong", "ts": time.time()})
                    elif obj.get("type") == "tts_state":
                        global _FE_TTS_PLAYING, _FE_TTS_LAST_END_AT
                        _FE_TTS_PLAYING = bool(obj.get("playing"))
                        _end = obj.get("lastEndAt")
                        if isinstance(_end, (int, float)) and _end > 0:
                            _FE_TTS_LAST_END_AT = float(_end) / 1000.0
                        try:
                            import cognition as _cg
                            _cg.tts_state(_FE_TTS_PLAYING, _FE_TTS_LAST_END_AT)
                        except Exception:
                            pass
    except WebSocketDisconnect:
        pass
    except Exception as e:
        dprint(f"[vision] speak 连接异常: {e}", flush=True)
    finally:
        try:
            _VISION_SPEAK_SOCKETS.remove(websocket)
        except Exception:
            pass


@app.get("/v1/memory/context")
async def memory_context():

    try:
        ctx = memory_system.resident_prompt()
        dprint(f"[memory] 常驻层已读取 {len(ctx)} 字", flush=True)
        return {"status": "success", "context": ctx}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.post("/v1/memory/recall")
async def memory_recall(request: Request):

    try:
        body = await request.json()
    except Exception:
        body = {}
    body = body if isinstance(body, dict) else {}
    text = str(body.get("text") or "").strip()
    if not text:
        return {"status": "success", "context": "", "hits": 0}
    try:
        force = bool(memory_system.is_force_recall(text))
        ctx = await run_in_threadpool(memory_system.recall_context, text, force)
        n = int(ctx.count("\n- ")) if ctx else 0
        dprint(f"[memory] 检索{'（强制）' if force else ''}: 命中 {n} 条 | q={text[:40]}", flush=True)
        return {"status": "success", "context": ctx or "", "hits": n, "force": force}
    except Exception as e:
        return {"status": "error", "message": str(e), "context": ""}


@app.post("/v1/memory/forget")
async def memory_forget():

    try:
        kept, removed = memory_system.forget()
        return {"status": "success", "kept": kept, "removed": removed}
    except Exception as e:
        return {"status": "error", "message": str(e)}


from fastapi import HTTPException
from starlette.background import BackgroundTask

try:
    import agent_bridge
except Exception as e:
    dprint(f"[backend] agent_bridge 加载失败: {e}")
    agent_bridge = None


def _stream_chat_enabled():

    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            v = (json.load(f).get("llm") or {}).get("stream_chat")
    except Exception:
        return True
    return True if v is None else bool(v)


def _log_reply(messages, final):
    final = _clean_final_text(final)
    log_chat("她说", final)
    _record_conv_history(messages, final)


@app.post("/v1/translate")
async def v1_translate(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    text = str((body or {}).get("text") or "").strip()
    if not text:
        return {"ok": False, "error": "没有要翻译的文字"}
    target = str((body or {}).get("target") or "").strip().lower()
    if target not in ("zh", "en"):
        target = "en" if any('\u4e00' <= ch <= '\u9fff' for ch in text) else "zh"
    if len(text) > 4000:
        text = text[:4000]

    try:
        import agent_bridge as ab
        cfg = ab.load_cfg()
        fcfg = json.loads(json.dumps(cfg or {}))
        fcfg.setdefault("llm", {})
        fcfg["llm"]["model"] = fcfg["llm"].get("fast_model") or fcfg["llm"].get("model") or "deepseek-flash"
        if target == "zh":
            sysp = "You are a translator. Translate the following text into natural, fluent Simplified Chinese. Output ONLY the translation, no explanations, no quotes, no extra words."
        else:
            sysp = "You are a translator. Translate the following text into natural, fluent English. Output ONLY the translation, no explanations, no quotes, no extra words."
        msgs = [
            {"role": "system", "content": sysp},
            {"role": "user", "content": text}
        ]
        _budget = max(512, min(4000, int(len(text) * 2) + 200))
        resp = ab._open_upstream(fcfg, msgs, False, retries=2, max_tokens_override=_budget)
        if resp is None:
            return {"ok": False, "error": "翻译服务暂时不可用"}
        with resp:
            data = json.loads(resp.read().decode("utf-8"))
        content = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        content = content.strip()
        if len(content) >= 2 and content[0] == content[-1] and content[0] in "\"'“”‘’":
            content = content[1:-1].strip()
        content = re.sub(r"[（(]\s*[A-Za-z][A-Za-z0-9 .\-']*[)）]", "", content).strip()
        content = re.sub(r"^\s*(译文|翻译|意思是|meaning|translation)\s*[:：]\s*", "", content, flags=re.I).strip()
        if not content:
            return {"ok": False, "error": "翻译结果为空"}
        return {"ok": True, "text": content}
    except Exception as e:
        dprint(f"[translate] 翻译失败: {e}", flush=True)
        return {"ok": False, "error": "翻译失败"}


@app.post("/v2/chat/completions")
async def v2_chat_completions(request: Request):
    if agent_bridge is None:
        raise HTTPException(500, "agent_bridge 不可用")
    try:
        body = await request.json()
    except Exception:
        body = {}
    messages = (body or {}).get("messages") or []
    _mem_mode = str((body or {}).pop("neuro_memory_mode", "chat") or "chat").lower()
    if _mem_mode not in ("chat", "opening", "proactive"):
        _mem_mode = "chat"
    _mark_user_interact()

    try:
        _last_user_msg = next((m.get("content") or "" for m in reversed(messages or [])
                               if isinstance(m, dict) and m.get("role") == "user"), "")
        import cognition as _cg
        if _cg.maybe_start_instruction_guard(str(_last_user_msg)):
            dprint(f"[cognition] 指令保护窗开启: {str(_last_user_msg)[:60]}", flush=True)
    except Exception as _e:
        dprint(f"[cognition] 指令识别失败（忽略）: {_e}", flush=True)

    try:
        import cognition as _cg
        _self_txt = _cg.self_state_text()
        if _self_txt:
            _sys_i = next((i for i, m in enumerate(messages)
                           if isinstance(m, dict) and m.get("role") == "system"), None)
            if _sys_i is None:
                messages.insert(0, {"role": "system", "content": _self_txt})
            else:
                messages[_sys_i]["content"] = (
                    (messages[_sys_i].get("content") or "") + "\n\n" + _self_txt).strip()
            dprint("[cognition] 已注入统一自我状态（合并进首条 system）", flush=True)
    except Exception as _e:
        dprint(f"[cognition] 自我状态注入失败（忽略）: {_e}", flush=True)

    try:
        import arbiter as _arb_i
        _st = _arb_i.status()
        _drv = _st.get("drive") or {}
        if _drv.get("available"):
            _ax = _drv.get("axes") or {}
            _inner = ("[Inner] want_to_speak={:.2f} arousal={:.2f} valence={:.2f} "
                      "tension={:.2f} recall={:.2f}").format(
                float(_drv.get("speak", 0.0)), float(_ax.get("arousal", 0.0)),
                float(_ax.get("valence", 0.0)), float(_ax.get("tension", 0.0)),
                float(_drv.get("recall", 0.0)))
            try:
                import arbiter as _arb_h
                _hb = _arb_h.heard_block()
                if _hb:
                    _inner += "\n" + _hb
            except Exception:
                pass
            _sys_i2 = next((i for i, m in enumerate(messages)
                            if isinstance(m, dict) and m.get("role") == "system"), None)
            if _sys_i2 is None:
                messages.insert(0, {"role": "system", "content": _inner})
            else:
                messages[_sys_i2]["content"] = (
                    (messages[_sys_i2].get("content") or "") + "\n\n" + _inner).strip()
            dprint(f"[mind] 已注入内在状态 {_inner}", flush=True)
    except Exception as _e:
        dprint(f"[mind] 内在状态注入失败（忽略）: {_e}", flush=True)


    _want_stream = bool((body or {}).get("stream"))
    _cfg_stream = _stream_chat_enabled()
    dprint(f"[backend] 主对话 走{'流式' if (_want_stream and _cfg_stream) else '非流式'}"
          f"（前端要流式={_want_stream}，配置stream_chat={_cfg_stream}）"
          f"，{len(messages)} 条消息", flush=True)
    try:
        _sysm = next((m for m in (messages or []) if m.get("role") == "system"), None)
        _syst = str((_sysm or {}).get("content") or "")
        _has_res = "【Resident】" in _syst
        _has_rec = "【Recollection】" in _syst
        dprint(f"[memory] 本轮请求：system {len(_syst)} 字，常驻={'是' if _has_res else '否'}"
               f"，情景回忆={'命中' if _has_rec else '沉默'}，上下文 {len(messages)} 条", flush=True)
    except Exception:
        pass

    try:
        await run_in_threadpool(inject_memory, messages, _mem_mode)
        dprint(f"[memory] 本轮模式={_mem_mode}", flush=True)
    except Exception as e:
        dprint(f"[memory] 后端注入失败（忽略）: {e}", flush=True)

    try:
        _vm = _get_vision_manager()
        _now_txt, _now_age = "", None
        try:
            import drive_client as _dc_att
            _st = _dc_att.latest_drive_state()
            _a = (getattr(_st, "raw", {}) or {}).get("attention") or {}
            if _a.get("text"):
                _now_txt = str(_a["text"])
                _now_age = _a.get("age_s")
        except Exception:
            pass
        _vctx = ""
        if _now_txt and _now_age is not None and float(_now_age) <= 20.0:
            _vctx = f"[Now] ({float(_now_age):.1f}s ago) {_now_txt}"
        _rest = _vm.observation_context() if _vm else ""
        if _rest:
            _vctx = (_vctx + "\n\n[Before]\n" + _rest).strip() if _vctx else _rest
        if _vctx:
            _sys_i = next((i for i, m in enumerate(messages)
                           if isinstance(m, dict) and m.get("role") == "system"), None)
            if _sys_i is None:
                messages.insert(0, {"role": "system", "content": _vctx.strip()})
            else:
                messages[_sys_i]["content"] = (
                    (messages[_sys_i].get("content") or "") + "\n\n" + _vctx).strip()
            dprint("[vision] 主对话已注入视觉观察上下文（合并进首条 system）", flush=True)
    except Exception as _e:
        dprint(f"[vision] 主对话注入失败（忽略）: {_e}", flush=True)


    _arb_vd = None
    try:
        import arbiter as _arb
        _last_user_txt = next((str(m.get("content") or "") for m in reversed(messages or [])
                               if isinstance(m, dict) and m.get("role") == "user"), "")
        _is_addr = _arb.addressing(_last_user_txt)
        _is_cmd = _arb.is_command(_last_user_txt)
        _kind = "idle" if _mem_mode == "proactive" else "reply"
        _arb_vd = _arb.decide(_kind, text=_last_user_txt, addressing=_is_addr,
                              command=_is_cmd)
        _arb.on_user_spoke(_last_user_txt, addressing=_is_addr)
        _arb.on_user_text(_last_user_txt)
        _arb.on_speech(_last_user_txt, 0.7)
        dprint(f"[mind] {_kind} → 脑开关={_arb_vd['action']} "
               f"({_arb_vd['reason']}) drive={_arb_vd['drive']}"
               f"{' user' if _is_cmd else ''}{' addr' if _is_addr else ''}", flush=True)
        if _arb_vd["action"] != "speak":
            _arb.remember_unheard(_last_user_txt)

            async def _quiet_gen():
                yield agent_bridge.sse_event(
                    {"silence": {"action": _arb_vd["action"], "reason": _arb_vd["reason"]}})
                yield "data: [DONE]\n\n"

            return StreamingResponse(_quiet_gen(), media_type="text/event-stream",
                                     headers={"Cache-Control": "no-cache",
                                              "X-Accel-Buffering": "no"})
    except Exception as _e:
        dprint(f"[mind] 状态注入失败（忽略）: {_e}", flush=True)

    if _want_stream and _cfg_stream:
        _MIN_SENTENCE_LEN = 4
        _MAX_SENTENCES_PER_TURN = 3
        _MAX_CHARS_PER_TURN = 320

        def _sentence_end(s):
            return s.endswith((".", "!", "?", "\n"))

        _sentinel = object()

        def _stream_producer(q):

            try:
                for ev in agent_bridge.chat_stream(body):
                    q.put(ev)
            except Exception as e:
                dprint(f"[backend] 流式生产线程异常: {e}", flush=True)
            finally:
                q.put(_sentinel)

        import queue as _queue
        _q = _queue.Queue()
        _producer = threading.Thread(target=_stream_producer, args=(_q,), daemon=True)
        _producer.start()

        async def _sse_gen():
            buf = []
            _sentence_buf = ""
            _sent_count = 0
            _char_count = 0
            _capped = False
            _head_buf = ""
            _head_done = False
            _noted_spoke = False
            try:
                while True:
                    ev = await asyncio.to_thread(_q.get)
                    if ev is _sentinel:
                        break
                    _delta = ((ev.get("choices") or [{}])[0].get("delta") or {})
                    c = _delta.get("content")
                    if c:
                        c = _plain_text(c)
                        if not _head_done and c:
                            _head_buf += c
                            if len(_head_buf.strip()) < 11:
                                continue
                            _head_done = True
                            if _head_buf.strip().upper().startswith("SILENT_TURN"):
                                dprint("[mind] 她自己决定这次不回应（SILENT_TURN）", flush=True)
                                yield agent_bridge.sse_event(
                                    {"silence": {"action": "silent", "reason": "model_chose"}})
                                yield "data: [DONE]\n\n"
                                return
                            c = _head_buf
                        if not _noted_spoke:
                            _noted_spoke = True
                            try:
                                import arbiter as _arb_s
                                _arb_s.note_spoke()
                            except Exception:
                                pass
                        if (_sent_count >= _MAX_SENTENCES_PER_TURN
                                or _char_count >= _MAX_CHARS_PER_TURN):
                            _delta["content"] = ""
                            if not _capped:
                                _capped = True
                                dprint("[backend] 本轮台词达到上限，停止转发多余正文", flush=True)
                        else:
                            _char_count += len(c)
                            _delta["content"] = c
                            buf.append(c)
                            _sentence_buf += c
                            if len(_sentence_buf) >= _MIN_SENTENCE_LEN and _sentence_end(_sentence_buf):
                                log_chat("她说", _clean_final_text(_sentence_buf))
                                _sentence_buf = ""
                                _sent_count += 1
                    yield agent_bridge.sse_event(ev)
            except Exception as e:
                dprint(f"[backend] 流式生成异常: {e}", flush=True)
                yield agent_bridge.sse_event({"emotion": "worried"})
                yield agent_bridge.sse_event(
                    {"choices": [{"delta": {"content": "Hmm, my brain isn't connecting right now. Say that again?"}}]}
                )
                buf.append("Hmm, my brain isn't connecting right now. Say that again?")
                _sentence_buf = ""
            if not _head_done and _head_buf.strip():
                _h = _head_buf.strip()
                if _h.upper().startswith("SILENT_TURN"):
                    dprint("[mind] 她自己决定这次不回应（SILENT_TURN/短）", flush=True)
                    yield agent_bridge.sse_event(
                        {"silence": {"action": "silent", "reason": "model_chose"}})
                    yield "data: [DONE]\n\n"
                    return
                _head_done = True
                yield agent_bridge.sse_event(
                    {"choices": [{"delta": {"content": _head_buf}}]})
                buf.append(_head_buf)
                _char_count += len(_head_buf)
                _clean_head = _clean_final_text(_head_buf).strip()
                if _clean_head:
                    log_chat("她说", _clean_head)
            yield "data: [DONE]\n\n"
            final = "".join(buf)
            if _capped:
                _sentence_buf = ""
            _tail = _clean_final_text(_sentence_buf).strip()
            if _tail and len(_tail) >= _MIN_SENTENCE_LEN:
                log_chat("她说", _tail)
                final = (final + " " + _tail).strip()
            elif _tail:
                final = (final + " " + _tail).strip()
            _record_conv_history(messages, final)

        return StreamingResponse(
            _sse_gen(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    try:
        final, extra = await run_in_threadpool(agent_bridge.chat_completions, body)
    except Exception as e:
        final = "[worried] Hmm, my brain isn't connecting right now. Say that again?"
        extra = {}
    final = _clean_final_text(final)
    if str(final or "").strip().upper().startswith("SILENT_TURN"):
        dprint("[mind] 她自己决定这次不回应（SILENT_TURN）", flush=True)
        return Response(content='data: {"silence":{"action":"silent",'
                                '"reason":"model_chose"}}\n\ndata: [DONE]\n\n',
                        media_type="text/event-stream",
                        headers={"Cache-Control": "no-cache"})
    _log_reply(messages, final)
    emo = (extra or {}).get("emotion")
    if body.get("stream"):
        return Response(content=agent_bridge.sse(final, emo), media_type="text/event-stream")
    return {
        "id": "neuro-proxy",
        "object": "chat.completion",
        "model": body.get("model", "deepseek-chat"),
        "emotion": emo,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": final}, "finish_reason": "stop"}],
    }


def _record_conv_history(messages, final):

    global _conv_history, _conv_history_lock
    if _conv_history_lock is None:
        _conv_history_lock = threading.Lock()
    last_user = ""
    for m in reversed(messages or []):
        if m.get("role") == "user" and m.get("content"):
            last_user = _text_of(m["content"])
            break
    with _conv_history_lock:
        if last_user:
            _conv_history.append({"role": "user", "content": last_user})
        if final:
            _conv_history.append({"role": "assistant", "content": final})
        while len(_conv_history) > 12:
            _conv_history.pop(0)


from contextlib import asynccontextmanager as _asynccontextmanager
from fastapi.responses import JSONResponse as _JSONResponse

if __name__ == "__main__":
    import asyncio as _asyncio
    import socket as _socket
    import sys as _sys

    import uvicorn

    def _port_taken(port: int = 6006) -> bool:

        s = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
        s.settimeout(0.4)
        try:
            s.connect(("127.0.0.1", port))
            return True
        except Exception:
            return False
        finally:
            try: s.close()
            except Exception: pass

    if _port_taken():
        dprint("[backend] 6006 已被占用（另有后端在跑），本进程退出 code=3", flush=True)
        _sys.exit(3)

    dprint("[backend] 启动 127.0.0.1:6006 ...")
    dprint(_CONFIG_NOTE)
    dprint(f"[backend] TTS 声线={TTS_VOICE_EN} 音调={TTS_PITCH} 语速={TTS_RATE}")

    try:
        _asyncio.run(_warmup_edge_tts(force=True))
    except Exception:
        pass

    if _port_taken():
        dprint("[backend] 预热期间 6006 被另一个后端抢占，本进程退出 code=3", flush=True)
        _sys.exit(3)

    uvicorn.run(app, host="127.0.0.1", port=6006, log_level="warning")
