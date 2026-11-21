from __future__ import annotations

import argparse
import collections
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

if os.environ.get("NEURO_FLY_DATA"):
    os.environ["FLY_DATA"] = os.environ["NEURO_FLY_DATA"]

if "NUMBA_NUM_THREADS" not in os.environ:
    _want = os.environ.get("NEURO_NUMBA_THREADS", "2").strip()
    if _want and _want != "0":
        os.environ["NUMBA_NUM_THREADS"] = _want

import numpy as np

from . import assoc as assoc_mod, clusters as clusters_mod
from . import encoder as encoder_mod
from . import trainer as trainer_mod
from . import heads as heads_mod
from . import persist, spare_pool
from . import episodes as episodes_mod, ckpt as ckpt_mod

DT = 0.020
DEFAULT_HZ = 30.0


def _text_ratio(a: str, b: str) -> float:

    a = (a or "").strip().lower()
    b = (b or "").strip().lower()
    if not a or not b:
        return 0.0
    try:
        import difflib
        return float(difflib.SequenceMatcher(None, a[:300], b[:300]).ratio())
    except Exception:
        sa, sb = set(a.split()), set(b.split())
        return (len(sa & sb) / len(sa | sb)) if (sa | sb) else 0.0


_MIN_BYTES = {"brain.npz": 20_000_000, "weights.npz": 100_000_000}


def _data_dir() -> Path:

    from flybrain import data as _fd
    return Path(_fd.DATA)


def _npz_ok(path: Path, min_bytes: int) -> bool:

    try:
        if not path.exists() or path.stat().st_size < min_bytes:
            return False
        import zipfile
        with zipfile.ZipFile(path) as z:
            if not z.namelist() or z.testzip() is not None:
                return False
        return True
    except Exception:
        return False


def _clean_partials(data: Path) -> int:

    removed = 0
    for pat in ("*.p[0-9][0-9]", "*.part", "*.crdownload", "*.download"):
        for p in data.glob(pat):
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
    return removed


def _verified_cache(data: Path):

    import hashlib
    p = data / ".verified.json"
    try:
        return p, json.loads(p.read_text("utf-8"))
    except Exception:
        return p, {}


def _ensure_brain_data() -> Path:

    from flybrain.data import FILES, download

    data = _data_dir()
    try:
        data.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise SystemExit(f"[brain] 无法创建数据目录 {data}：{e}")

    n = _clean_partials(data)
    if n:
        print(f"[brain] 已清理残留分片 {n} 个", flush=True)

    cache_path, cache = _verified_cache(data)

    def stamp(p: Path) -> str:
        st = p.stat()
        return f"{st.st_size}:{st.st_mtime_ns}"

    bad = []
    for name, floor in _MIN_BYTES.items():
        p = data / name
        if not p.exists():
            continue
        if cache.get(name) == stamp(p):
            continue
        if not _npz_ok(p, floor):
            bad.append(p)
        else:
            cache[name] = stamp(p)

    for p in bad:
        size_mb = p.stat().st_size / 1e6
        print(f"[brain] {p.name} 不完整（{size_mb:.0f}MB），删除后重下", flush=True)
        try:
            p.unlink()
        except OSError as e:
            raise SystemExit(f"[brain] 无法删除损坏文件 {p}：{e}")

    missing = [n for n in FILES if not (data / n).exists()]
    if missing:
        print(f"[brain] 首次运行：下载连接组数据（约 260MB，仅一次）→ {data}", flush=True)
        try:
            download(data)
        except Exception as e:
            raise SystemExit(
                f"[brain] 下载失败：{e}\n"
                f"[brain] 请删除 {data} 后重试（需约 260MB 磁盘、可访问 GitHub 的网络）。")

    for name, floor in _MIN_BYTES.items():
        p = data / name
        if not _npz_ok(p, floor):
            raise SystemExit(
                f"[brain] {p} 仍不完整。请删除 {data} 后重试。")
        cache[name] = stamp(p)

    try:
        cache_path.write_text(json.dumps(cache), "utf-8")
    except Exception:
        pass
    return data


class BrainCore:
    def __init__(self, seed: int = 64, save_every_s: float = 12.0, hz: float = DEFAULT_HZ,
                 managed: bool = False):
        from flybrain import FlyBrain
        self.hz = float(hz)
        self.period = 1.0 / self.hz
        self.brain = FlyBrain(device="cpu", sensory_input=False, seed=seed)
        self.lock = threading.Lock()
        self.frame = 0
        self.fps = 0.0
        self.ms = 0.0
        self.head = heads_mod.load("default")
        self._pending: list[dict] = []
        self._feat_now: dict = {}
        self._axes = {k: 0.0 for k in heads_mod.AXES}
        self._acts = {k: 0.0 for k in heads_mod.ACTIONS}
        self._speaking = False
        self._save_every_s = save_every_s
        self._last_save = time.time()
        self.trace_path = persist.STATE / "trace.jsonl"
        persist.STATE.mkdir(parents=True, exist_ok=True)

        man = spare_pool.load()
        self.pools = {k: np.asarray(v, dtype=np.int64) for k, v in man["pools"].items()}
        self._pool_rates = {k: 0.0 for k in self.pools}

        self.groups = {k.removeprefix("group_"): np.asarray(v, dtype=np.int64)
                       for k, v in self.brain.groups.items()}
        self._pool_arrays = {k: v for k, v in self.pools.items() if v.size}
        self._lut = {}
        self._lut_ready = False

        ct = np.asarray(self.brain.cell_type).astype(str)
        self.kc_idx = np.flatnonzero(np.char.startswith(ct, "KC"))
        self.mbon_idx = np.flatnonzero(np.char.startswith(ct, "MBON"))
        self.pam_idx = np.flatnonzero(np.char.startswith(ct, "PAM"))
        self.ppl_idx = np.flatnonzero(np.char.startswith(ct, "PPL"))
        self.vis_idx = np.asarray(self.brain.visual, dtype=np.int64)
        self.orn_idx = np.flatnonzero(np.char.startswith(ct, "ORN"))
        self.assoc = assoc_mod.AssocMemory(self.kc_idx, self.mbon_idx)
        self.clusters = clusters_mod.AffectClusters()
        self._recall = {"strength": 0.0, "affect": [0.0] * 4, "action": [0.0] * 3}
        self._cluster = {"cluster": -1, "n_clusters": 0, "confidence": 0.0}

        self.viz_n = 256
        self.viz_idx = np.linspace(0, self.brain.n - 1, self.viz_n).astype(np.int64)
        self.viz_ring = collections.deque(maxlen=60)
        self._viz_region_cache = None

        self.v3_n = int(os.environ.get("NEURO_VIZ3D_N", "16384"))
        self.v3_idx = np.linspace(0, self.brain.n - 1, self.v3_n).astype(np.int64)
        self.v3_ring = collections.deque(maxlen=40)
        self._prepare_viz3d()
        self._build_lookups()

        self.scalars = {"habituation": 0.35, "company_satiety": 0.5}
        self.percepts = collections.deque(maxlen=8)
        self.attention_slot = {"source": "", "text": "", "at": 0.0, "salience": 0.0}
        self.percept_kc = None
        self.speech_kc = None
        self.speech_at = 0.0
        self._mem_key_source = "firing"
        self.encoder = encoder_mod.PerceptEncoder(int(self.kc_idx.size))
        self.intero = collections.deque(maxlen=9000)
        self._load_state()

        self.trainer = trainer_mod.Trainer(self)
        self._last_reward_at = 0.0
        self.episodes = episodes_mod.EpisodeLedger()
        self._last_episode_at = 0.0
        self._last_event = None
        self.managed = bool(managed)
        self._last_client = time.time()
        self._idle_limit = float(os.environ.get('NEURO_BRIDGE_IDLE_S', '120'))
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="brain", daemon=True)

    def _load_state(self):
        a_ok = self.assoc.load()
        e_ok = self.encoder.load()
        c_ok = self.clusters.load()
        if a_ok or c_ok or e_ok:
            print(f"[brain] 记忆读档: assoc={'ok' if a_ok else '-'} "
                  f"enc={'ok' if e_ok else '-'} "
                  f"clusters={len(self.clusters.centroids)}", flush=True)
        got = persist.load(self.brain)
        if not got:
            print("[brain] 新的一生（无存档）")
            return
        self.scalars = persist.advance_offline(got["scalars"], got["offline_s"])
        if "sleep_pressure" in self.scalars and "habituation" not in self.scalars:
            self.scalars["habituation"] = float(self.scalars.pop("sleep_pressure") or 0.35)
            print("[brain] 迁移：sleep_pressure → habituation")
        self.scalars.setdefault("habituation", 0.35)
        self.scalars.pop("sleep_pressure", None)
        if float(self.scalars.get("company_satiety", 0.45)) < 0.2:
            self.scalars["company_satiety"] = 0.35
            print("[brain] 迁移：company_satiety 过低 → 重置为 0.35")
        self.frame = int(self.brain.steps)
        print(f"[brain] 读档: 帧 {self.frame}, 离线 {got['offline_s'] / 3600:.2f} h, "
              f"习惯化 {self.scalars.get('habituation', 0):.2f}")

    def touch(self):
        self._last_client = time.time()

    def _orphan_watch(self):
        while not self._stop.is_set():
            time.sleep(5)
            if not self.managed:
                continue
            if time.time() - self._last_client > self._idle_limit:
                print(f"[bridge] {int(self._idle_limit)}s 没有客户端，判定父进程已退出 → 存档并退出",
                      flush=True)
                try:
                    self.stop()
                except Exception:
                    pass
                os._exit(0)

    def start(self):
        self._thread.start()
        if self.managed:
            threading.Thread(target=self._orphan_watch, name='orphan-watch', daemon=True).start()

    def stop(self):

        self._stop.set()
        self._thread.join(timeout=3)
        try:
            _st = self.trainer.consolidate(self)
            print(f"[brain] 关机前巩固: {_st}", flush=True)
        except Exception as e:
            print(f"[brain] 关机前巩固失败（忽略）: {e}", file=sys.stderr)
        self._save()

    def _save(self):
        try:
            persist.save(self.brain, self.scalars)
            self.assoc.save()
            self.clusters.save()
            self.encoder.save()
            self.episodes.flush()
            self._last_save = time.time()
        except Exception as e:
            print(f"[persist] 存盘失败: {e}", file=sys.stderr)

    def push_input(self, payload: dict):
        with self.lock:
            self._pending.append(payload)

    def reward(self, r: float, why: str = "", expr: str | None = None):

        with self.lock:
            self.head = heads_mod.update(self.head, self._feat_now, r, why=why)
            heads_mod.save(self.head)
            label = expr or self.clusters.expression()
            self.clusters.reinforce(label, r)
            try:
                if self.percepts and float(r or 0.0) != 0.0:
                    ax = self._axes or {}
                    tgt = np.resize(np.asarray(
                        [ax.get("valence", 0.0), ax.get("arousal", 0.0),
                         ax.get("tension", 0.0), ax.get("satiety", 0.0)],
                        dtype=np.float32), encoder_mod.DIM)
                    self.encoder.learn(self.percepts[-1]["text"], tgt, float(r))
            except Exception as e:
                print(f"[encoder] learn 失败（忽略）: {e}", file=sys.stderr)
        self._attribute_reward(float(r), why)
        self._last_reward_at = time.time()
        self._trace({"ev": "reward", "r": r, "why": why, "expr": label})
        self._reward_pending = True

    def _attribute_reward(self, r: float, why: str):
        try:
            last = getattr(self, "_last_event", None)
            feats = (last or {}).get("f") or dict(self._feat_now)
            axes = (last or {}).get("ax") or dict(self._axes)
            acts = (last or {}).get("a") or dict(self._acts)
            key = (last or {}).get("key", "")
            outcome = "responded" if r > 0.02 else ("dismissed" if r < -0.2 else "none")
            self.episodes.record(feats, axes, acts, r, why=why,
                                 outcome=outcome, key=key,
                                 novelty=abs(float(r)))
            self._last_episode_at = time.time()
        except Exception:
            pass

    def _loop(self):
        t_next = time.perf_counter()
        while not self._stop.is_set():
            try:
                self._step_once()
            except Exception as e:
                print(f"[brain] step error (loop keeps running): {e}", file=sys.stderr)
            t_next += self.period
            sleep = t_next - time.perf_counter()
            if sleep > 0:
                time.sleep(sleep)
            else:
                t_next = time.perf_counter()

    def _step_once(self):
        t0 = time.perf_counter()
        with self.lock:
            pend = self._pending
            self._pending = []
        inj = []
        for p in pend:
            inj += self._encode(p)
            self._intero_push(p)
            self._percept_push(p)
            self._speech_push(p)
        for idx, amount in inj:
            self._apply(idx, amount)
        _raw = float(sum(float(np.abs(np.asarray(a, dtype=np.float32)).mean())
                         for _, a in inj)) if inj else 0.0
        self._drive = max(_raw, getattr(self, "_drive", 0.0) * 0.90)
        sense_drive = self._drive
        fired = self.brain.step()
        self.frame += 1

        _kpos = self._lut["kc"][np.asarray(fired, dtype=np.int64)]
        _kpos = _kpos[_kpos >= 0]
        kc = self.assoc.code(fired, hits=_kpos)
        _att_age = None
        if self.attention_slot.get("text"):
            _att_age = time.time() - float(self.attention_slot.get("at") or 0)
        if self.percept_kc is not None and _att_age is not None and _att_age <= 30.0:
            kc = kc.copy()
            kc[self.percept_kc] = 1.0
            self._mem_key_source = "percept+firing"
        else:
            self._mem_key_source = "firing"
        if self.speech_kc is not None and (time.time() - float(self.speech_at or 0)) <= 30.0:
            kc = kc.copy()
            kc[self.speech_kc] = 1.0
            self._mem_key_source = ("speech+" + self._mem_key_source)

        rec = self.assoc.recall(kc)

        rates = self._pooled_rates(fired)
        feats = self._features(rates, fired, self.assoc.stats, sense_drive, rec)
        axes, acts = heads_mod.forward(self.head, feats)

        cl = self.clusters.observe(axes)
        salience = 0.5 * abs(axes["arousal"]) + 0.4 * abs(axes["tension"]) \
            + 0.3 * abs(axes["valence"]) + 0.5 * float(rec.get("strength", 0.0))
        _fi = np.asarray(fired, dtype=np.int64)

        def _rate(name, idx):
            lut = self._lut.get(name)
            if lut is None or not len(idx):
                return 0.0
            return float((lut[_fi] >= 0).sum()) / max(1.0, float(idx.size))
        gate = min(1.0, 0.2 + 6.0 * (_rate("pam", self.pam_idx) + _rate("ppl", self.ppl_idx))
                    + 0.4 * float(cl["was_new"]))
        _evt = ((self.percept_kc is not None and _att_age is not None and _att_age < 1.0)
                or bool(getattr(self, "_reward_pending", False)))
        if _evt:
            self.assoc.write(kc, self.assoc.target(axes, acts), salience, gate)
            self._reward_pending = False
        self.assoc.decay()

        inj2 = []
        pool = self._pool_arrays.get("affect_integrator")
        if pool is not None and rec.get("strength", 0.0) > 0:
            aff = np.asarray(rec["affect"], dtype=np.float32)
            inj2.append((pool, self._col(aff.mean()) * 0.02 * min(3.0, rec["strength"])))
        if self.mbon_idx.size and rec.get("strength", 0.0) > 0:
            inj2.append((self.mbon_idx, self._col(0.05 * min(3.0, rec["strength"]))))
        for idx, amount in inj2:
            self._apply(idx, amount)

        with self.lock:
            self._feat_now = feats
            self._axes, self._acts = axes, acts
            self._pool_rates = rates
            self._recall = rec
            self._cluster = cl
        self._push_viz(fired)
        self._push_viz3d(fired)
        self._update_speaking(acts["speak"])

        _hab = float(self.scalars.get("habituation", 0.35))
        self.scalars["habituation"] = float(
            max(0.0, min(1.0, _hab + (0.35 - _hab) * (DT / 600.0))))
        _sat = float(self.scalars.get("company_satiety", 0.45))
        self.scalars["company_satiety"] = float(
            max(0.0, min(1.0, _sat + (0.45 - _sat) * (DT / 300.0))))

        self.ms = (time.perf_counter() - t0) * 1000
        self.fps = 1.0 / max(1e-9, (time.perf_counter() - t0))
        try:
            self.trainer.maybe_run()
        except Exception as e:
            print(f"[trainer] 巩固失败（忽略）: {e}", file=sys.stderr)
        if time.time() - self._last_save > self._save_every_s:
            self._save()

    @staticmethod
    def _col(a) -> np.ndarray:

        return np.asarray(a, dtype=np.float32).reshape(-1, 1)

    def _apply(self, idx, amount):

        arr = np.asarray(amount, dtype=np.float32)
        i = np.asarray(idx, dtype=np.int64)
        if arr.ndim == 0:
            self.brain.stimulate(i, float(arr))
        else:
            self.brain.v[i] += arr.reshape(-1, 1)

    def _encode(self, p: dict) -> list:

        inj = []
        s = (p.get("senses") or {})
        vis = s.get("vision") or []
        if vis:
            visual = np.asarray(self.brain.visual, dtype=np.int64)
            n = min(len(vis), len(visual))
            if n > 0:
                inj.append((visual[:n], self._col(vis[:n]) * 0.6))
        aud = float(s.get("audio") or 0.0)
        if aud > 0:
            pool = self._pool_arrays.get("intero_buffer")
            if pool is not None:
                inj.append((pool, float(min(1.0, aud)) * 0.25))
        touch = s.get("touch") or []
        if touch:
            pool = self._pool_arrays.get("affect_integrator")
            amp = float(sum(float(t[1]) for t in touch if len(t) > 1))
            if pool is not None and amp > 0:
                inj.append((pool, float(min(1.0, amp)) * 0.3))
        pairs = [(int(a), float(b)) for a, b in (s.get("smell") or [])
                 if isinstance(a, (int, float))]
        if pairs:
            inj.append((np.asarray([a for a, _ in pairs], dtype=np.int64),
                        self._col([b for _, b in pairs]) * 0.5))
        pool = self._pool_arrays.get("affect_integrator")
        if pool is not None:
            _nov = 1.0 - float(self.scalars.get("habituation", 0.35))
            inj.append((pool, (_nov - 0.5) * 0.10))
        return inj

    def _pooled_rates(self, fired) -> dict:
        if not len(fired):
            return {k: 0.0 for k in self.pools}
        fi = np.asarray(fired, dtype=np.int64)
        out = {}
        for name, idx in self.pools.items():
            lut = self._lut.get("pool:" + name)
            n_hit = int((lut[fi] >= 0).sum()) if lut is not None and idx.size else 0
            out[name] = float(n_hit) / float(idx.size) if idx.size else 0.0
        return out

    def _features(self, rates: dict, fired, kc_stats: dict = None, drive: float = 0.0,
                 rec: dict = None) -> dict:
        f = np.asarray(fired, dtype=np.int64)
        feats = {"spont": float(len(fired)) / float(self.brain.n)}
        for g in ("escape", "forward", "steer"):
            idx = self.groups.get(g)
            lut = self._lut.get("grp:" + g)
            feats[g] = (float((lut[f] >= 0).sum()) / max(1.0, float(idx.size))
                        if idx is not None and lut is not None else 0.0)
        feats["hr_affect"] = float(rates.get("affect_integrator", 0.0))
        feats["hr_emotion"] = float(rates.get("emotion_valence", 0.0)
                                    + rates.get("emotion_arousal", 0.0)) / 2.0
        feats["intero_replied"] = float(self.scalars.get("company_satiety", 0.5))
        feats["novelty"] = float(1.0 - float(self.scalars.get("habituation", 0.35)))
        def _rate(name, idx):
            lut = self._lut.get(name)
            if lut is None or idx is None or not len(idx):
                return 0.0
            return float((lut[f] >= 0).sum()) / max(1.0, float(idx.size))
        feats["vis"] = _rate("vis", getattr(self, "vis_idx", None))
        feats["orn"] = _rate("orn", getattr(self, "orn_idx", None))
        feats["kc"] = float((kc_stats or {}).get("surprise", 0.0))
        mbon_rate = _rate("mbon", getattr(self, "mbon_idx", None))
        self._mbon_ema = 0.98 * getattr(self, "_mbon_ema", 0.9) + 0.02 * mbon_rate
        feats["mbon"] = float(mbon_rate - self._mbon_ema)
        feats["drive"] = float(min(2.0, drive))
        r = rec or {}
        aff = r.get("affect") or [0.0, 0.0, 0.0, 0.0]
        conf = float(r.get("confidence", 0.0) or 0.0)
        feats["recall_val"] = float(aff[0]) * conf
        feats["recall_aro"] = float(aff[1]) * conf
        feats["recall_conf"] = conf
        return feats

    def _update_speaking(self, drive: float):

        if not self._speaking and drive > 0.62:
            self._speaking = True
            self._trace({"ev": "speak_start", "drive": round(drive, 3)})
            self._capture_event("speak_start")
        elif self._speaking and drive < 0.42:
            self._speaking = False
            self._trace({"ev": "speak_stop", "drive": round(drive, 3)})

    def _capture_event(self, kind: str, key: str = ""):
        try:
            self._last_event = {
                "kind": kind,
                "key": key,
                "f": dict(self._feat_now or {}),
                "ax": dict(self._axes or {}),
                "a": dict(self._acts or {}),
                "at": time.time(),
            }
        except Exception:
            pass

    def _speech_push(self, p: dict):

        sp = p.get("speech") or {}
        text = (sp.get("text") or "").strip()
        if not text:
            return
        vec = self.encoder.encode(text)
        kc = self.encoder.text_to_kc(text)
        self.speech_kc = kc if kc.size else None
        self.speech_at = time.time()
        pool = self._pool_arrays.get("affect_integrator")
        if pool is not None and pool.size:
            self._apply(pool, self._col(0.05))

    def _percept_push(self, p: dict):

        pc = p.get("percept") or {}
        text = (pc.get("text") or "").strip()
        if not text:
            return
        s = max(0.0, min(1.0, float(pc.get("salience", 0.5) or 0.5)))
        now = time.time()
        prev_text = self.percepts[-1]["text"] if self.percepts else ""
        sim = _text_ratio(prev_text, text) if prev_text else 0.0
        hab = float(self.scalars.get("habituation", 0.35))
        hab += (0.10 if sim >= 0.7 else -0.20)
        self.scalars["habituation"] = max(0.0, min(1.0, hab))

        vec = self.encoder.encode(text)
        kc = self.encoder.to_kc(vec)
        self.percept_kc = kc if kc.size else None
        if kc.size:
            self._apply(self.kc_idx[kc], self._col(0.60))

        self.percepts.append({"text": text[:400], "salience": s, "at": now,
                              "vec": vec, "kc": int(kc.size)})
        self.attention_slot = {"source": str(pc.get("kind") or "vision"),
                               "text": text[:400], "at": now, "salience": s,
                               "novelty": round(1.0 - float(self.scalars["habituation"]), 3)}
        if s >= 0.5:
            self._capture_event("observe", key=text[:48])
        pool = self._pool_arrays.get("affect_integrator")
        if pool is not None and pool.size:
            self._apply(pool, self._col(0.10 * max(0.1, s)))

    def _intero_push(self, p: dict):
        it = p.get("intero") or {}
        if not it:
            return
        self.intero.append({"t": round(time.time(), 3), **it})
        if it.get("outcome") == "praise":
            self.scalars["company_satiety"] = min(
                1.0, float(self.scalars.get("company_satiety", 0.5)) + 0.05)
        elif it.get("outcome") == "interrupt":
            self.scalars["company_satiety"] = max(
                0.0, float(self.scalars.get("company_satiety", 0.5)) - 0.03)

    def _trace(self, obj: dict):
        try:
            with open(self.trace_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({"t": round(time.time(), 3), "frame": self.frame, **obj},
                                   ensure_ascii=False) + "\n")
        except Exception:
            pass

    def _build_lookups(self):

        n = int(self.brain.n)

        def _mk(idx):
            a = np.full(n, -1, dtype=np.int32)
            idx = np.asarray(idx, dtype=np.int64)
            if idx.size:
                a[idx] = np.arange(idx.size, dtype=np.int32)
            return a

        self._lut = {}
        for k, idx in self.pools.items():
            if idx.size:
                self._lut["pool:" + k] = _mk(idx)
        for k, idx in (("kc", self.kc_idx), ("vis", self.vis_idx), ("orn", self.orn_idx),
                       ("mbon", self.mbon_idx), ("pam", self.pam_idx), ("ppl", self.ppl_idx),
                       ("viz3d", self.v3_idx), ("viz2d", self.viz_idx)):
            if idx is not None and len(idx):
                self._lut[k] = _mk(idx)
        for g, idx in self.groups.items():
            if idx is not None and len(idx):
                self._lut["grp:" + g] = _mk(idx)
        self._lut_ready = True

    def _prepare_viz3d(self):

        pos = np.array(self.brain.positions, dtype=np.float32, copy=True)
        sc = np.asarray(self.brain.superclass).astype(str)
        self.v3_sc_names = sorted(set(sc.tolist()))
        sc_id = np.zeros(len(sc), dtype=np.uint8)
        for i, name in enumerate(self.v3_sc_names):
            sc_id[sc == name] = i

        bad = ~np.isfinite(pos).all(axis=1)
        self.v3_imputed = int(bad.sum())
        if self.v3_imputed:
            good = ~bad
            rng = np.random.default_rng(64)
            for name in self.v3_sc_names:
                m = sc == name
                gm = m & good
                if not gm.any():
                    pos[m] = rng.normal(0, 1, size=(int(m.sum()), 3)).astype(np.float32)
                    continue
                c = pos[gm].mean(axis=0)
                sd = pos[gm].std(axis=0) * 0.15 + 1e-3
                n_bad = int((m & bad).sum())
                pos[m & bad] = c + rng.normal(0, 1, size=(n_bad, 3)).astype(np.float32) * sd

        lo = pos.min(axis=0)
        hi = pos.max(axis=0)
        span = np.maximum(hi - lo, 1e-6)
        self.v3_bounds = [lo.tolist(), hi.tolist()]
        center = (lo + hi) / 2.0
        scale = float(span.max() / 2.0)
        self.v3_norm = (pos - center) / scale

        sel = self.v3_idx
        self.v3_points = self.v3_norm[sel].astype(np.float32)
        self.v3_points_sc = sc_id[sel]
        self.v3_spont_last = 0.0
        import struct as _struct
        self._v3_blob = b"".join([
            _struct.pack("<4sii", b"NV3D", 1, self.v3_n),
            _struct.pack("<6f", *self.v3_bounds[0], *self.v3_bounds[1]),
            self.v3_points.tobytes(),
            self.v3_points_sc.tobytes(),
        ])

    def _push_viz3d(self, fired):
        try:
            lut = self._lut["viz3d"]
            pos = lut[np.asarray(fired, dtype=np.int64)]
            pos = pos[pos >= 0]
            hit = np.zeros(self.v3_n, dtype=np.uint8)
            hit[pos] = 1
            self.v3_ring.append((self.frame, np.packbits(hit).tobytes()))
            self.v3_spont_last = float(pos.size) / float(self.v3_n)
        except Exception:
            pass

    def viz3d_meta(self) -> dict:
        return {"v": 1, "ok": True, "n_total": int(self.brain.n), "n_sample": self.v3_n,
                "bits_per_frame": (self.v3_n + 7) // 8, "bounds": self.v3_bounds,
                "superclasses": self.v3_sc_names, "imputed": self.v3_imputed,
                "hz": self.hz}

    def viz3d_payload(self, since: int = 0, limit: int = 6) -> dict:
        import base64
        with self.lock:
            burst = [(f, d) for f, d in self.v3_ring if f > since][-limit:]
            speaking = self._speaking
            frame = self.frame
        return {"v": 1, "ok": True, "frame": frame, "n_sample": self.v3_n,
                "frames": [{"f": f, "d": base64.b64encode(d).decode("ascii")} for f, d in burst],
                "spont": round(self.v3_spont_last, 4), "speaking": speaking,
                "axes": dict(self._axes), "hz": self.hz}

    def viz3d_points(self) -> bytes:
        return self._v3_blob

    def attention(self) -> dict:

        slot = getattr(self, "attention_slot", None) or {}
        if slot.get("text"):
            return {"text": slot.get("text", ""),
                    "age_s": round(time.time() - float(slot.get("at") or 0), 2),
                    "salience": round(float(slot.get("salience", 0.0)), 3),
                    "novelty": slot.get("novelty", 0.0),
                    "source": slot.get("source", ""),
                    "count": len(self.percepts)}
        if not self.percepts:
            return {"text": "", "age_s": None, "salience": 0.0, "count": 0}
        last = self.percepts[-1]
        return {"text": last.get("text", ""),
                "age_s": round(time.time() - float(last.get("at") or 0), 2),
                "salience": round(float(last.get("salience", 0.0)), 3),
                "count": len(self.percepts)}

    def _push_viz(self, fired):

        try:
            lut = self._lut["viz2d"]
            pos = lut[np.asarray(fired, dtype=np.int64)]
            pos = pos[pos >= 0]
            hit = np.zeros(self.viz_n, dtype=np.uint8)
            hit[pos] = 1
            self.viz_ring.append((self.frame, np.packbits(hit).tobytes()))
        except Exception:
            pass

    def viz_payload(self, since: int = 0, limit: int = 6) -> dict:

        with self.lock:
            burst = [(f, d) for f, d in self.viz_ring if f > since][-limit:]
            axes = dict(self._axes)
            speaking = self._speaking
            frame = self.frame
        import base64
        return {
            "v": 1,
            "frame": frame,
            "n": self.viz_n,
            "frames": [{"f": f, "d": base64.b64encode(d).decode("ascii")} for f, d in burst],
            "rates": {k: round(float(v), 4) for k, v in self._pool_rates.items()},
            "spont": round(float(self._feat_now.get("spont", 0.0)), 4),
            "kc": round(float(self._feat_now.get("kc", 0.0)), 4),
            "mbon": round(float(self._feat_now.get("mbon", 0.0)), 4),
            "speaking": speaking,
            "axes": axes,
            "hz": self.hz,
        }

    def snapshot(self) -> dict:
        with self.lock:
            axes = dict(self._axes)
            acts = dict(self._acts)
            feats = dict(self._feat_now)
            rates = dict(self._pool_rates)
            speaking = self._speaking
            frame = self.frame
        return {
            "v": 1,
            "t": round(time.time(), 3),
            "frame": frame,
            "actions": acts,
            "speaking": speaking,
            "value": heads_mod.value(self.head, feats),
            "emotion": self._emotion(axes),
            "recall": dict(self._recall),
            "attention": self.attention(),
            "memory_key": self._mem_key_source,
            "learning": {"runs": self.trainer.runs, "last": self.trainer.last_stats},
            "axes": axes,
            "features": {k: round(v, 4) for k, v in feats.items()},
            "pools": {k: round(v, 4) for k, v in rates.items()},
            "scalars": {k: round(float(v), 3) for k, v in self.scalars.items()},
            "health": {"fps": round(self.fps, 1), "ms": round(self.ms, 2), "hz": self.hz,
                       "brain_time_ratio": round(self.hz * DT, 3)},
        }

    def _emotion(self, axes: dict) -> dict:

        with self.lock:
            cl = dict(self._cluster)
        label = self.clusters.expression()
        return {
            "cluster": int(cl.get("cluster", -1)),
            "n_clusters": int(cl.get("n_clusters", 0)),
            "confidence": float(cl.get("confidence", 0.0)),
            "labels_learned": sum(1 for d in self.clusters.expr if d),
            "label": label,
            "axes": axes,
        }


class Handler(BaseHTTPRequestHandler):
    core: BrainCore = None
    protocol_version = "HTTP/1.1"

    def _send(self, code: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, body: bytes, ctype: str = "application/octet-stream"):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            Handler.core.touch()
        except Exception:
            pass
        if self.path.startswith("/health"):
            self._send(200, {"ok": True, "frame": self.core.frame,
                             "fps": round(self.core.fps, 1), "ms": round(self.core.ms, 2)})
        elif self.path.startswith("/out"):
            self._send(200, self.core.snapshot())
        elif self.path.startswith("/state"):
            snap = self.core.snapshot()
            snap["intero_tail"] = list(self.core.intero)[-20:]
            snap["head_updates"] = int(self.core.head.get("updates", 0))
            self._send(200, snap)
        elif self.path.startswith("/shutdown"):
            self._send(200, {"ok": True, "bye": True})
            threading.Thread(target=self._graceful_exit).start()
        elif self.path.startswith("/learn/status"):
            self._send(200, {"ok": True, **self.core.trainer.status()})
        elif self.path.startswith("/learn/report"):
            from . import learn as _learn
            ep_stats = self.core.episodes.stats()
            hold = self.core.episodes.holdout()
            ev = _learn.evaluate(self.core.head, hold)
            self._send(200, {"ok": True, "episodes": ep_stats,
                             "eval": ev, "head_updates": int(self.core.head.get("updates", 0)),
                             "head_meta": self.core.head.get("meta", {}),
                             "ckpt": ckpt_mod.list_ckpt("heads")})
        elif self.path.startswith("/viz3d/points"):
            self._send_bytes(self.core.viz3d_points())
        elif self.path.startswith("/viz3d/meta"):
            self._send(200, self.core.viz3d_meta())
        elif self.path.startswith("/viz3d/spikes"):
            since = 0
            try:
                from urllib.parse import urlparse, parse_qs
                q = parse_qs(urlparse(self.path).query)
                since = int((q.get("since") or ["0"])[0])
            except Exception:
                pass
            self._send(200, self.core.viz3d_payload(since=since))
        elif self.path.startswith("/viz"):
            since = 0
            try:
                from urllib.parse import urlparse, parse_qs
                q = parse_qs(urlparse(self.path).query)
                since = int((q.get("since") or ["0"])[0])
            except Exception:
                pass
            self._send(200, self.core.viz_payload(since=since))
        else:
            self._send(404, {"error": "unknown path"})

    @staticmethod
    def _graceful_exit():
        import time as _t
        _t.sleep(0.2)
        try:
            Handler.core.stop()
        except Exception:
            pass
        os._exit(0)

    def do_POST(self):
        try:
            Handler.core.touch()
        except Exception:
            pass
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            self._send(400, {"error": "bad json"})
            return
        if self.path.startswith("/shutdown"):
            self._send(200, {"ok": True, "bye": True})
            threading.Thread(target=self._graceful_exit).start()
        elif self.path.startswith("/in"):
            self.core.push_input(payload)
            self._send(200, {"ok": True, "frame": self.core.frame})
        elif self.path.startswith("/reward"):
            self.core.reward(float(payload.get("r", 0.0)), str(payload.get("why", "")),
                             payload.get("expr"))
            self._send(200, {"ok": True, "updates": self.core.head.get("updates", 0)})
        elif self.path.startswith("/learn/rollback"):
            from . import heads as _heads
            ok = ckpt_mod.rollback("heads", _heads.HEADS / "default.json")
            if ok:
                try:
                    self.core.head = _heads.load("default")
                except Exception:
                    pass
            self._send(200, {"ok": True, "rolled_back": ok})
        else:
            self._send(404, {"error": "unknown path"})

    def log_message(self, fmt, *args):
        pass

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionResetError, BrokenPipeError, OSError):
            self.close_connection = True


class _ExclusiveServer(ThreadingHTTPServer):

    daemon_threads = True


def _already_serving(port: int, timeout: float = 1.2) -> bool:

    import urllib.request

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=timeout) as r:
            if r.status != 200:
                return False
            return b'"frame"' in r.read(4096)
    except Exception:
        return False


def serve(port: int = 6007, seed: int = 64, hz: float = DEFAULT_HZ, managed: bool = False):
    if _already_serving(port):
        print(f"[bridge] 端口 {port} 已有脑桥在跑，本进程退出（不重复仿真）", flush=True)
        return
    _ensure_brain_data()
    core = None
    try:
        core = BrainCore(seed=seed, hz=hz, managed=managed)
        Handler.core = core
        core.start()
        srv = _ExclusiveServer(("127.0.0.1", port), Handler)
        print(f"[bridge] http://127.0.0.1:{port}  brain={core.brain.n} neurons  hz={hz}", flush=True)
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            srv.server_close()
    finally:
        if core is not None:
            core.stop()
            print("[bridge] stopped, state saved", flush=True)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=6007)
    ap.add_argument("--seed", type=int, default=64)
    ap.add_argument("--hz", type=float, default=DEFAULT_HZ,
                    help="steps per real second (50 = 1x biological time)")
    ap.add_argument("--managed", action="store_true",
                    help="由桌面端拉起：客户端消失后自动退出")
    a = ap.parse_args(argv)
    serve(a.port, a.seed, a.hz, a.managed)


if __name__ == "__main__":
    main()
