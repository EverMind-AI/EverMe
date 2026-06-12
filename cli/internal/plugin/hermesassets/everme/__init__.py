"""EverMe memory plugin for Hermes — native MemoryProvider.

Auto-captures every turn to EverMe via framework hooks (no model-initiated
tool calls). Per-turn trajectories -> /mem/agent-memory; durable user facts
are mirrored from Hermes builtin memory writes (on_memory_write, deduped and
coalesced) -> /mem/personal; recall from /mem/search + /mem/context.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider
from tools.registry import tool_error

from .client import EverMeClient, redact_error
from .config import resolve_config

logger = logging.getLogger(__name__)

_BREAKER_THRESHOLD = 5
_BREAKER_COOLDOWN_SECS = 120
_NO_WRITE_CONTEXTS = {"cron", "flush", "subagent"}
_QUERY_MAX_CHARS = 1024
_MAX_CONTENT_CHARS = 8000  # backend MaxMessageContentRunes — cap to avoid 400 "content too long"
_PREFETCH_JOIN_TIMEOUT = 3.0
_SYNC_JOIN_TIMEOUT = 5.0
# Builtin-memory mirror writes are buffered and posted as ONE /mem/personal
# request (flush=true) after this quiet window, so a burst of entry updates
# lands in a single upstream memcell instead of one episode per write. The
# BFF has no message-less flush call, so flush frequency — not the flush
# flag itself — is the only dial. The debounce resets on every write, so a
# hard deadline (_FACT_MAX_WAIT_SECS from the first buffered fact) and a
# size trigger (_FACT_BATCH_MAX, also the per-POST chunk size — well under
# the BFF's 500-message cap) bound how long and how large the buffer can get.
_FACT_DEBOUNCE_SECS = 10.0
_FACT_MAX_WAIT_SECS = 30.0
_FACT_BATCH_MAX = 100
_MAX_SEEN_FACTS = 256

_SEARCH_SCHEMA = {
    "name": "mem_search",
    "description": (
        "Search the user's EverMe memory by meaning. Pass ONE short, focused "
        "query (<=1024 chars) — NOT a whole conversation. Returns relevant past "
        "facts and episodes. Recall is automatic each turn; call this only when "
        "you need to look something specific up."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "A short focused query."},
            "topK": {"type": "integer", "description": "Max results (default 5, max 20)."},
        },
        "required": ["query"],
    },
}
_CONTEXT_SCHEMA = {
    "name": "mem_context",
    "description": (
        "Fetch the user's stored profile (preferences, traits, durable facts). "
        "No query needed — returns the full profile block. Use at the start of a "
        "task to ground yourself in who the user is."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}
def _now_ms() -> int:
    return int(time.time() * 1000)


def _coerce_ts(ts):
    if isinstance(ts, (int, float)):
        return int(ts) if ts > 10_000_000_000 else int(ts * 1000)
    return _now_ms()


def _cap(text):
    s = text if isinstance(text, str) else ("" if text is None else str(text))
    return s[:_MAX_CONTENT_CHARS]


def _to_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, str):
                parts.append(p)
            elif isinstance(p, dict):
                parts.append(p.get("text") or p.get("content") or "")
        return "\n".join(x for x in parts if x)
    if isinstance(content, dict) and isinstance(content.get("text"), str):
        return content["text"]
    return ""


def _last_turn(messages):
    """Return only the latest turn from a cumulative OpenAI-style message
    list: the last user message plus everything after it (assistant reply +
    any tool-call/tool-result messages of that turn). Mirrors Claude Code's
    lastTurn() — Hermes hands sync_turn the FULL running history every turn,
    so posting all of it would re-add the entire conversation each turn."""
    if not messages:
        return []
    last_user = -1
    for i, m in enumerate(messages):
        if isinstance(m, dict) and m.get("role") == "user":
            last_user = i
    if last_user < 0:
        return list(messages)
    return list(messages[last_user:])


def _convert_agent_messages(messages):
    """Convert Hermes OpenAI-style messages to backend AgentMemoryMessage
    dicts. Mirrors agent-sdk convertAgentMessage. Drops messages that
    can't be represented. Each carries an epoch-ms timestamp."""
    out = []
    for m in messages or []:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        ts = _coerce_ts(m.get("timestamp"))
        if role == "user":
            content = _to_text(m.get("content"))
            if content:
                out.append({"role": "user", "timestamp": ts, "content": _cap(content)})
        elif role == "assistant":
            text_parts = []
            tool_calls = []
            c = m.get("content")
            if isinstance(c, str):
                text_parts.append(c)
            for block in (c if isinstance(c, list) else []):
                if not isinstance(block, dict) or not block.get("type"):
                    continue
                if block["type"] == "text" and isinstance(block.get("text"), str):
                    text_parts.append(block["text"])
                elif block["type"] in ("toolCall", "tool_use"):
                    args = block.get("arguments", block.get("input", {}))
                    tool_calls.append({
                        "id": block.get("id", ""),
                        "type": "function",
                        "name": block.get("name") or "unknown",
                        "arguments": args if isinstance(args, str) else json.dumps(args),
                    })
            # merge pre-extracted tool calls passed alongside string content
            for tc in m.get("toolCalls") or m.get("tool_calls") or []:
                if isinstance(tc, dict):
                    fn = tc.get("function") if isinstance(tc.get("function"), dict) else tc
                    args = fn.get("arguments")
                    tool_calls.append({
                        "id": tc.get("id", ""),
                        "type": "function",
                        "name": fn.get("name") or "unknown",
                        "arguments": args if isinstance(args, str) else json.dumps(args or {}),
                    })
            msg = {"role": "assistant", "timestamp": ts}
            text = _to_text(text_parts)
            if text:
                msg["content"] = _cap(text)
            if tool_calls:
                msg["toolCalls"] = tool_calls
            if "content" in msg or tool_calls:
                out.append(msg)
        elif role in ("tool", "tool_result"):
            tcid = m.get("toolCallId") or m.get("tool_call_id")
            if tcid:
                out.append({"role": "tool", "timestamp": ts, "toolCallId": tcid,
                            "content": _cap(_to_text(m.get("content")))})
    return out


class EverMeMemoryProvider(MemoryProvider):
    def __init__(self):
        self._cfg: Dict[str, str] = {}
        self._client: Optional[EverMeClient] = None
        self._client_lock = threading.Lock()
        self._conversation_id = ""
        self._hermes_home = ""
        self._write_enabled = True
        self._prefetch_result = ""
        self._prefetch_lock = threading.Lock()
        self._breaker_lock = threading.Lock()
        self._prefetch_thread: Optional[threading.Thread] = None
        self._sync_thread: Optional[threading.Thread] = None
        self._profile_block = ""
        self._consecutive_failures = 0
        self._breaker_open_until = 0.0
        self._fact_lock = threading.Lock()
        self._pending_facts: List[Dict[str, Any]] = []
        self._pending_cid = ""
        self._first_pending_at = 0.0
        self._seen_facts: set = set()
        self._fact_timer: Optional[threading.Timer] = None
        self._fact_thread: Optional[threading.Thread] = None

    @property
    def name(self) -> str:
        return "everme"

    def is_available(self) -> bool:
        if self._cfg:
            return bool(self._cfg.get("agent_token"))
        home = self._hermes_home
        if not home:
            try:
                from hermes_constants import get_hermes_home
                home = str(get_hermes_home())
            except Exception:
                home = ""
        return bool(resolve_config(home).get("agent_token"))

    # -- circuit breaker -----------------------------------------------------
    def _is_breaker_open(self) -> bool:
        with self._breaker_lock:
            if self._consecutive_failures < _BREAKER_THRESHOLD:
                return False
            if time.monotonic() >= self._breaker_open_until:
                self._consecutive_failures = 0
                return False
            return True

    def _record_success(self) -> None:
        with self._breaker_lock:
            self._consecutive_failures = 0

    def _record_failure(self) -> None:
        with self._breaker_lock:
            self._consecutive_failures += 1
            if self._consecutive_failures >= _BREAKER_THRESHOLD:
                self._breaker_open_until = time.monotonic() + _BREAKER_COOLDOWN_SECS
                logger.warning("EverMe circuit breaker tripped; pausing %ds", _BREAKER_COOLDOWN_SECS)

    def _get_client(self) -> EverMeClient:
        with self._client_lock:
            if self._client is None:
                self._client = EverMeClient(self._cfg)
            return self._client

    # -- lifecycle -----------------------------------------------------------
    def initialize(self, session_id: str, **kwargs) -> None:
        self._hermes_home = kwargs.get("hermes_home", "") or self._hermes_home
        if not self._cfg:
            self._cfg = resolve_config(self._hermes_home)
        self._conversation_id = session_id
        agent_context = kwargs.get("agent_context", "primary")
        self._write_enabled = agent_context not in _NO_WRITE_CONTEXTS
        # Warm the profile block for the system prompt (best-effort).
        try:
            res = self._get_client().request("POST", "/mem/context", {})
            self._profile_block = _render_profile(res)
            self._record_success()
        except Exception as e:
            self._record_failure()
            logger.debug("EverMe initialize context fetch failed: %s", redact_error(e))

    def system_prompt_block(self) -> str:
        if not self._profile_block:
            return ""
        return f"# EverMe Memory\n{self._profile_block}"

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if self._is_breaker_open():
            return ""
        if self._prefetch_thread and self._prefetch_thread.is_alive():
            self._prefetch_thread.join(timeout=_PREFETCH_JOIN_TIMEOUT)
        with self._prefetch_lock:
            result = self._prefetch_result
            self._prefetch_result = ""
        return f"## EverMe Memory\n{result}" if result else ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        if self._is_breaker_open():
            return
        q = (query or "")[:_QUERY_MAX_CHARS]

        def _run():
            try:
                res = self._get_client().request("POST", "/mem/search", {"query": q, "topK": 5})
                lines = _render_search(res)
                if lines:
                    with self._prefetch_lock:
                        self._prefetch_result = lines
                self._record_success()
            except Exception as e:
                self._record_failure()
                logger.debug("EverMe prefetch failed: %s", redact_error(e))

        self._prefetch_thread = threading.Thread(target=_run, daemon=True, name="everme-prefetch")
        self._prefetch_thread.start()

    def _post_messages(self, messages: List[Dict[str, Any]], flush: bool,
                       conversation_id: str = "") -> None:
        """Background POST of converted agent messages to /mem/agent-memory."""
        if self._is_breaker_open() or not messages:
            return
        body = {"conversationId": conversation_id or self._conversation_id, "messages": messages, "flush": flush}

        def _run():
            try:
                self._get_client().request("POST", "/mem/agent-memory", body)
                self._record_success()
            except Exception as e:
                self._record_failure()
                logger.warning("EverMe sync failed: %s", redact_error(e))

        if self._sync_thread and self._sync_thread.is_alive():
            self._sync_thread.join(timeout=_SYNC_JOIN_TIMEOUT)
        self._sync_thread = threading.Thread(target=_run, daemon=True, name="everme-sync")
        self._sync_thread.start()

    def sync_turn(self, user_content: str, assistant_content: str, *,
                  session_id: str = "", messages: Optional[List[Dict[str, Any]]] = None) -> None:
        if not self._write_enabled:
            return
        cid = session_id or self._conversation_id
        if messages:
            converted = _convert_agent_messages(_last_turn(messages))
        else:
            ts = _now_ms()
            converted = []
            if user_content:
                converted.append({"role": "user", "timestamp": ts, "content": _cap(user_content)})
            if assistant_content:
                converted.append({"role": "assistant", "timestamp": ts, "content": _cap(assistant_content)})
        if not converted:
            return
        self._post_messages(converted, flush=True, conversation_id=cid)

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        # No-op: each turn is flushed at sync_turn time (matches Claude Code).
        return

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        return ""

    def on_session_switch(self, new_session_id: str, *, parent_session_id: str = "",
                          reset: bool = False, rewound: bool = False, **kwargs) -> None:
        with self._fact_lock:
            messages, cid = self._detach_pending_facts_locked()
            self._seen_facts.clear()
            self._conversation_id = new_session_id
        self._start_fact_flush(messages, cid)

    def on_memory_write(self, action: str, target: str, content: str,
                        metadata: Optional[Dict[str, Any]] = None) -> None:
        """Mirror a Hermes builtin memory write into the EverMe profile.

        The sole /mem/personal entry point: writes are deduped per session
        (the model retrying an entry update must not multiply episodes) and
        buffered behind a debounce timer so a burst posts once. The timer
        resets per write but never past _FACT_MAX_WAIT_SECS from the first
        buffered fact, and the buffer flushes immediately at _FACT_BATCH_MAX
        — a steady write trickle can neither starve the flush nor grow the
        buffer unboundedly."""
        if not self._write_enabled or target != "user" or action == "remove" or not content:
            return
        if self._is_breaker_open():
            return
        fact = _cap(content)
        flush_messages: List[Dict[str, Any]] = []
        flush_cid = ""
        with self._fact_lock:
            if fact in self._seen_facts:
                return
            if len(self._seen_facts) >= _MAX_SEEN_FACTS:
                self._seen_facts.clear()
            self._seen_facts.add(fact)
            if not self._pending_facts:
                # Stamp the batch's conversation id when the buffer opens so
                # a later flush (timer or session switch) attributes these
                # facts to the session they were written in.
                self._pending_cid = self._conversation_id
                self._first_pending_at = time.monotonic()
            self._pending_facts.append({"role": "user", "timestamp": _now_ms(), "content": fact})
            if len(self._pending_facts) >= _FACT_BATCH_MAX:
                flush_messages, flush_cid = self._detach_pending_facts_locked()
            else:
                if self._fact_timer is not None:
                    self._fact_timer.cancel()
                delay = min(_FACT_DEBOUNCE_SECS,
                            self._first_pending_at + _FACT_MAX_WAIT_SECS - time.monotonic())
                timer = threading.Timer(max(delay, 0.0), self._flush_pending_facts)
                timer.daemon = True
                self._fact_timer = timer
                timer.start()
        if flush_messages:
            self._start_fact_flush(flush_messages, flush_cid)

    def _detach_pending_facts_locked(self) -> tuple[List[Dict[str, Any]], str]:
        """Close the current fact batch while _fact_lock is held."""
        if self._fact_timer is not None:
            self._fact_timer.cancel()
            self._fact_timer = None
        if not self._pending_facts:
            return [], ""
        messages = self._pending_facts
        cid = self._pending_cid or self._conversation_id
        self._pending_facts = []
        self._pending_cid = ""
        self._first_pending_at = 0.0
        return messages, cid

    def _flush_pending_facts(self) -> None:
        """Drain the fact buffer into /mem/personal POSTs with flush=true.

        flush must ride on a message-carrying request (the BFF rejects empty
        messages), so it cannot be deferred past this post — coalescing is
        what keeps the flush count down. Messages go out in _FACT_BATCH_MAX
        chunks so a large buffer can never trip the BFF's 500-message cap."""
        with self._fact_lock:
            messages, cid = self._detach_pending_facts_locked()
        self._send_fact_messages(messages, cid)

    def _send_fact_messages(self, messages: List[Dict[str, Any]], cid: str) -> None:
        while messages:
            chunk, messages = messages[:_FACT_BATCH_MAX], messages[_FACT_BATCH_MAX:]
            body = {"conversationId": cid, "messages": chunk, "flush": True}
            try:
                self._get_client().request("POST", "/mem/personal", body)
                self._record_success()
            except Exception as e:
                self._record_failure()
                logger.warning("EverMe personal flush failed (%d facts dropped): %s",
                               len(chunk) + len(messages), redact_error(e))
                return

    def _spawn_fact_flush(self) -> None:
        """Close and send the current fact batch on its own thread — never joins on the
        caller, so main-loop hooks (session switch, batch trigger) stay
        non-blocking. Tracked separately from _sync_thread so the two write
        paths cannot clobber each other's slot."""
        with self._fact_lock:
            messages, cid = self._detach_pending_facts_locked()
        self._start_fact_flush(messages, cid)

    def _start_fact_flush(self, messages: List[Dict[str, Any]], cid: str) -> None:
        if not messages:
            return
        self._fact_thread = threading.Thread(
            target=self._send_fact_messages, args=(messages, cid),
            daemon=True, name="everme-factflush")
        self._fact_thread.start()

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [_SEARCH_SCHEMA, _CONTEXT_SCHEMA]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        if self._is_breaker_open():
            return tool_error("EverMe temporarily unavailable (consecutive failures); will retry automatically.")
        try:
            client = self._get_client()
        except Exception as e:
            return tool_error(redact_error(e))

        try:
            if tool_name == "mem_search":
                query = (args.get("query") or "").strip()
                if not query:
                    return tool_error("Missing required parameter: query")
                top_k = min(int(args.get("topK", 5) or 5), 20)
                res = client.request("POST", "/mem/search", {"query": query[:_QUERY_MAX_CHARS], "topK": top_k})
                self._record_success()
                return json.dumps({"result": _render_search(res) or "No relevant memories found."})

            if tool_name == "mem_context":
                res = client.request("POST", "/mem/context", {})
                self._record_success()
                return json.dumps({"result": _render_profile(res) or "No profile stored yet."})

        except Exception as e:
            self._record_failure()
            return tool_error(redact_error(e))

        return tool_error(f"Unknown tool: {tool_name}")

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {"key": "agent_token", "description": "EverMe agent token (evt_...)",
             "secret": True, "required": True, "env_var": "EVERME_AGENT_TOKEN",
             "url": "https://www.everme.evermind.ai"},
            {"key": "agent_id", "description": "EverMe agent id (agt_...)",
             "env_var": "EVERME_AGENT_ID"},
            {"key": "api_base", "description": "EverMe API base URL",
             "default": "https://api.everme.evermind.ai", "env_var": "EVERME_API_BASE"},
        ]

    def shutdown(self) -> None:
        self._spawn_fact_flush()
        for t in (self._prefetch_thread, self._sync_thread, self._fact_thread):
            if t and t.is_alive():
                t.join(timeout=_SYNC_JOIN_TIMEOUT)
        with self._client_lock:
            self._client = None


def _render_search(res: Any) -> str:
    if not isinstance(res, dict):
        return ""
    lines = []
    for it in res.get("items") or []:
        if not isinstance(it, dict):
            continue
        episode = (it.get("episode") or "").strip()
        if episode:
            lines.append(f"- {episode}")
            for fact in it.get("atomicFacts") or []:
                if fact:
                    lines.append(f"  - {fact}")
    return "\n".join(lines)


def _render_profile(res: Any) -> str:
    if not isinstance(res, dict):
        return ""
    profile = res.get("profile") if "profile" in res else res
    if not isinstance(profile, dict):
        return ""
    lines = []
    for row in profile.get("explicit_info") or []:
        if not isinstance(row, dict):
            continue
        desc = (row.get("description") or "").strip()
        if desc:
            cat = f"[{row['category']}] " if row.get("category") else ""
            lines.append(f"- {cat}{desc}")
    for row in profile.get("implicit_traits") or []:
        if not isinstance(row, dict):
            continue
        desc = (row.get("description") or "").strip()
        if desc:
            t = f"{row['trait']}: " if row.get("trait") else ""
            lines.append(f"- {t}{desc}")
    return "\n".join(lines)


def register(ctx) -> None:
    ctx.register_memory_provider(EverMeMemoryProvider())
