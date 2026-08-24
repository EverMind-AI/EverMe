"""Inject a minimal fake raven.memory_engine so the backend imports
without a real Raven install. Call install_fakes() at the top of every
test module, before importing everme_raven.*"""
import sys
import types
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict


def install_fakes():
    # raven.memory_engine.Memory — the frozen dataclass the backend returns.
    if "raven.memory_engine" not in sys.modules:
        raven_pkg = types.ModuleType("raven")
        raven_pkg.__path__ = []
        me_mod = types.ModuleType("raven.memory_engine")

        @dataclass(frozen=True)
        class Memory:
            text: str
            score: float = 0.0
            metadata: Dict[str, Any] = field(default_factory=dict)

        me_mod.Memory = Memory
        sys.modules["raven"] = raven_pkg
        sys.modules["raven.memory_engine"] = me_mod


def make_plugin_importable():
    """Put the plugin dir (the one holding everme_raven/) on sys.path —
    the same thing Raven's registry does for user-dir plugins."""
    plugin_dir = Path(__file__).resolve().parent.parent / "everme-memory"
    p = str(plugin_dir)
    if p not in sys.path:
        sys.path.insert(0, p)


class FakeContext:
    """Duck-typed PluginContext: the backend only reads .config and .logger."""

    def __init__(self, config=None, logger=None):
        self.config = config or {}
        self.logger = logger
