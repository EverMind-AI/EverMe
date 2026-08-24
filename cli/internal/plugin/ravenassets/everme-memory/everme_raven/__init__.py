"""EverMe memory backend for Raven — external user-dir plugin.

Implements Raven's MemoryBackend Protocol (raven.memory_engine.backend)
against the EverMe cloud /mem BFF: recall from /mem/search (+ profile
from /mem/context), per-turn trajectories to /mem/agent-memory. The
factory entry point is everme_raven.backend:make_backend, referenced
from raven-plugin.toml.
"""
from __future__ import annotations

__version__ = "0.1.0"

from .backend import EverMeBackend, make_backend  # noqa: F401
