import json
import os

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_CONFIG = os.path.join(PROJECT_ROOT, "config.json")
SECRETS_FILE = os.environ.get("NEURO_SECRETS") or os.path.join(PROJECT_ROOT, "secrets.json")

_SECRET_MAP = {
    "llm_api_key": ("llm", "api_key"),
    "deepseek_api_key": ("deepseek", "api_key"),
    "llm_upstream_url": ("llm", "upstream_url"),
    "llm_model": ("llm", "model"),
    "zhipu_api_key": ("vision", "free", "api_key"),
    "embedding_api_key": ("memory", "embeddings", "api_key"),
}


def load_secrets():

    try:
        if not os.path.isfile(SECRETS_FILE):
            return {}
        with open(SECRETS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _set_path(cfg, path, value):
    cur = cfg
    for k in path[:-1]:
        nxt = cur.get(k)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[k] = nxt
        cur = nxt
    cur[path[-1]] = value


def apply_secrets(cfg, secrets=None):

    if cfg is None:
        return cfg
    secrets = load_secrets() if secrets is None else secrets
    if not secrets:
        return cfg
    for skey, path in _SECRET_MAP.items():
        val = secrets.get(skey)
        if isinstance(val, str) and val.strip():
            _set_path(cfg, path, val.strip())
    return cfg


def load_config(path=None):

    p = path or DEFAULT_CONFIG
    with open(p, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    return apply_secrets(cfg)
