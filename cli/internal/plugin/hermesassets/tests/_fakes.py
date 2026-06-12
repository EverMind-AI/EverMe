"""Inject minimal fake Hermes modules so the provider imports without a
real hermes-agent install. Call install_fakes() at the top of every test
module, before importing everme.*"""
import sys
import types
from abc import ABC, abstractmethod
from pathlib import Path


def install_fakes(hermes_home: str = "/tmp/everme-test-home"):
    # agent.memory_provider.MemoryProvider — the ABC the provider subclasses.
    if "agent.memory_provider" not in sys.modules:
        agent_pkg = types.ModuleType("agent")
        agent_pkg.__path__ = []
        mp_mod = types.ModuleType("agent.memory_provider")

        class MemoryProvider(ABC):
            @property
            @abstractmethod
            def name(self): ...
            @abstractmethod
            def is_available(self): ...
            @abstractmethod
            def initialize(self, session_id, **kwargs): ...
            def system_prompt_block(self): return ""
            def prefetch(self, query, *, session_id=""): return ""
            def queue_prefetch(self, query, *, session_id=""): ...
            def sync_turn(self, user_content, assistant_content, *, session_id="", messages=None): ...
            @abstractmethod
            def get_tool_schemas(self): ...
            def handle_tool_call(self, tool_name, args, **kwargs): raise NotImplementedError
            def shutdown(self): ...
            def on_session_end(self, messages): ...
            def on_session_switch(self, new_session_id, *, parent_session_id="", reset=False, rewound=False, **kwargs): ...
            def on_pre_compress(self, messages): return ""
            def on_memory_write(self, action, target, content, metadata=None): ...
            def get_config_schema(self): return []
            def save_config(self, values, hermes_home): ...

        mp_mod.MemoryProvider = MemoryProvider
        sys.modules["agent"] = agent_pkg
        sys.modules["agent.memory_provider"] = mp_mod

    # tools.registry.tool_error
    if "tools.registry" not in sys.modules:
        tools_pkg = types.ModuleType("tools")
        tools_pkg.__path__ = []
        reg_mod = types.ModuleType("tools.registry")
        import json as _json
        reg_mod.tool_error = lambda msg: _json.dumps({"error": str(msg)})
        sys.modules["tools"] = tools_pkg
        sys.modules["tools.registry"] = reg_mod

    # hermes_constants.get_hermes_home
    if "hermes_constants" not in sys.modules:
        hc_mod = types.ModuleType("hermes_constants")
        hc_mod.get_hermes_home = lambda: Path(hermes_home)
        sys.modules["hermes_constants"] = hc_mod


def make_everme_importable():
    """Put the everme/ package dir's parent on sys.path."""
    pkg_parent = str(Path(__file__).resolve().parent.parent)
    if pkg_parent not in sys.path:
        sys.path.insert(0, pkg_parent)
