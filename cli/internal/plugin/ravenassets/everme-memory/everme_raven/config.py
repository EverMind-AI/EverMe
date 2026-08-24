"""Config resolution for the EverMe Raven backend.

Priority (highest first):
  1. the plugin config dict — plugins.config["everme-memory"] from
     ~/.raven/config.json, handed to make_backend(ctx) verbatim by
     Raven's plugin registry (this is what evercli writes at install)
  2. process env (EVERME_API_BASE / EVERME_AGENT_ID / EVERME_AGENT_TOKEN)
  3. compiled defaults

No network calls. api_base always carries the /api/v1 suffix so callers
don't have to think about it (mirrors the Hermes provider's config.py).
Unlike Hermes there is no everme.env file: config.json is Raven's
canonical credential store (same posture as OpenClaw's plugins.entries).
"""
from __future__ import annotations

import os
from typing import Any, Dict

DEFAULT_API_BASE = "https://api.everme.evermind.ai"
API_PATH_PREFIX = "/api/v1"
DEFAULT_FLUSH_EVERY_TURNS = 1
DEFAULT_TIMEOUT_S = 30.0

_ENV_BY_KEY = {
    "api_base": "EVERME_API_BASE",
    "agent_id": "EVERME_AGENT_ID",
    "agent_token": "EVERME_AGENT_TOKEN",
}


def _pick(key: str, cfg: Dict[str, Any]) -> str:
    raw = cfg.get(key)
    if raw:
        return str(raw)
    env = os.environ.get(_ENV_BY_KEY[key])
    if env:
        return env
    return ""


def _normalize_base(raw: str) -> str:
    base = (raw or DEFAULT_API_BASE).rstrip("/")
    if base.endswith(API_PATH_PREFIX):
        return base
    return base + API_PATH_PREFIX


def _coerce_int(raw: Any, default: int) -> int:
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


def _coerce_float(raw: Any, default: float) -> float:
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default


def resolve_config(cfg: Dict[str, Any] | None) -> Dict[str, Any]:
    cfg = cfg or {}
    return {
        "api_base": _normalize_base(_pick("api_base", cfg)),
        "agent_id": _pick("agent_id", cfg),
        "agent_token": _pick("agent_token", cfg),
        "flush_every_turns": _coerce_int(
            cfg.get("flush_every_turns"), DEFAULT_FLUSH_EVERY_TURNS
        ),
        "timeout_s": _coerce_float(cfg.get("timeout_s"), DEFAULT_TIMEOUT_S),
    }
