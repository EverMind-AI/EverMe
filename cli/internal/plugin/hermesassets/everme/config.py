"""Credential/config resolution for the EverMe Hermes provider.

Priority (highest first):
  1. explicit kwargs (flag)
  2. process env (EVERME_API_BASE / EVERME_AGENT_ID / EVERME_AGENT_TOKEN)
  3. $HERMES_HOME/everme.env (KEY=VALUE lines, mode 0600)
  4. compiled defaults

No network calls. api_base always carries the /api/v1 suffix so callers
don't have to think about it (mirrors agent-sdk config.js).
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, Optional

DEFAULT_API_BASE = "https://api.everme.evermind.ai"
API_PATH_PREFIX = "/api/v1"
_KEYS = ("EVERME_API_BASE", "EVERME_AGENT_ID", "EVERME_AGENT_TOKEN")


def _read_env_file(hermes_home: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    try:
        path = Path(hermes_home) / "everme.env"
        if not path.is_file():
            return out
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip()
    except Exception:
        pass
    return out


def _pick(key: str, kwargs: dict, env_file: Dict[str, str]) -> str:
    flag = kwargs.get(key.lower().replace("everme_", ""))
    if flag:
        return str(flag)
    if os.environ.get(key):
        return os.environ[key]
    if env_file.get(key):
        return env_file[key]
    return ""


def _normalize_base(raw: str) -> str:
    base = (raw or DEFAULT_API_BASE).rstrip("/")
    if base.endswith(API_PATH_PREFIX):
        return base
    return base + API_PATH_PREFIX


def resolve_config(hermes_home: str, **kwargs) -> Dict[str, str]:
    env_file = _read_env_file(hermes_home)
    return {
        "api_base": _normalize_base(_pick("EVERME_API_BASE", kwargs, env_file)),
        "agent_id": _pick("EVERME_AGENT_ID", kwargs, env_file),
        "agent_token": _pick("EVERME_AGENT_TOKEN", kwargs, env_file),
    }
