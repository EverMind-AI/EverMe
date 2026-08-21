"""EverMeBackend — Raven MemoryBackend against the EverMe cloud /mem BFF.

Endpoint mapping (all POST, Bearer evt auth via client.py):

  recall()  -> /mem/search   {query, topK} -> {items: [{episode, atomicFacts}]}
               user track additionally prepends the profile block warmed
               from /mem/context at start()
  store()   -> /mem/agent-memory {conversationId, messages, flush}
               messages carry epoch-ms timestamps and preserved toolCalls
  feedback  -> no EverMe sink yet; logged once and dropped (same posture
               as the bundled everos-memory backend)

Error posture: recall/store failures are logged truthfully (redacted)
and swallowed — the AgentLoop turn pipeline must not abort because the
memory index is unreachable. There is no no-op "degraded mode": a
missing agent_token fails construction loudly so the operator re-runs
`evercli plugin install raven` instead of running memory-less silently.

The host hands store() only the current turn's message slice
(all_msgs[turn_start_idx:]), so no last-turn trimming is needed here
(unlike the Hermes provider, which receives the full running history).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Dict, List, Optional

from raven.memory_engine import Memory

from .client import EverMeClient, redact_error
from .config import resolve_config

logger = logging.getLogger("raven.plugin.everme")

_QUERY_MAX_CHARS = 1024
_QUERY_MIN_CHARS = 3
_MAX_CONTENT_CHARS = 8000  # backend MaxMessageContentRunes — avoid 400 "content too long"


def make_backend(ctx) -> "EverMeBackend":
    """Factory referenced from raven-plugin.toml."""
    return EverMeBackend(ctx)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _coerce_ts(ts) -> int:
    if isinstance(ts, (int, float)):
        return int(ts) if ts > 10_000_000_000 else int(ts * 1000)
    return _now_ms()


def _cap(text) -> str:
    s = text if isinstance(text, str) else ("" if text is None else str(text))
    return s[:_MAX_CONTENT_CHARS]


def _to_text(content) -> str:
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


def _convert_messages(messages) -> List[Dict[str, Any]]:
    """Convert Raven AgentLoop messages (OpenAI-style dicts) to backend
    AgentMemoryMessage dicts. Mirrors the Hermes provider's converter:
    system messages are dropped, tool calls are preserved with JSON-string
    arguments, and every message carries an epoch-ms timestamp."""
    out: List[Dict[str, Any]] = []
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
            msg: Dict[str, Any] = {"role": "assistant", "timestamp": ts}
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


def _clamp_score(raw: Any) -> float:
    """Coerce a relevanceScore to a float clamped to [0, 1]."""
    try:
        return max(0.0, min(float(raw or 0.0), 1.0))
    except (TypeError, ValueError):
        return 0.0


def _meta(mem_type: str, owner_type: str, mem_id: Any) -> Dict[str, Any]:
    m: Dict[str, Any] = {"type": mem_type, "owner_type": owner_type}
    if mem_id:
        m["id"] = mem_id
    return m


def _search_to_memories(res: Any, owner_type: str) -> List[Memory]:
    """Flatten a /mem/search result into list[Memory], one Memory per hit.

    Three hit kinds are rendered, each as an indented bullet block so the
    host's top-k trimming and score ordering stay meaningful:

    - episodic ``items`` — the episode line plus its atomic facts;
    - ``agentMemory.cases`` — a trajectory's task intent + approach;
    - ``agentMemory.skills`` — a clustered skill's name/description/content.

    Cases and skills are the products of the /mem/agent-memory writes this
    backend makes, so recall has to surface them — dropping them (the
    original bug) meant an agent could never read back what its own
    trajectories produced. Scores read ``relevanceScore`` (the real BFF
    field name) across all three kinds."""
    out: List[Memory] = []
    if not isinstance(res, dict):
        return out
    for it in res.get("items") or []:
        if not isinstance(it, dict):
            continue
        episode = (it.get("episode") or "").strip()
        if not episode:
            continue
        lines = [f"- {episode}"]
        for fact in it.get("atomicFacts") or []:
            if fact:
                lines.append(f"  - {fact}")
        out.append(Memory(text="\n".join(lines),
                          score=_clamp_score(it.get("relevanceScore")),
                          metadata=_meta("episode", owner_type, it.get("id"))))

    agent_memory = res.get("agentMemory")
    if isinstance(agent_memory, dict):
        for c in agent_memory.get("cases") or []:
            if not isinstance(c, dict):
                continue
            intent = (c.get("taskIntent") or "").strip()
            approach = (c.get("approach") or "").strip()
            if not intent and not approach:
                continue
            lines = []
            if intent:
                lines.append(f"- Task: {intent}")
            if approach:
                lines.append(f"  - Approach: {approach}")
            out.append(Memory(text="\n".join(lines),
                              score=_clamp_score(c.get("relevanceScore")),
                              metadata=_meta("case", owner_type, c.get("id"))))

        for s in agent_memory.get("skills") or []:
            if not isinstance(s, dict):
                continue
            name = (s.get("name") or "").strip()
            desc = (s.get("description") or "").strip()
            content = (s.get("content") or "").strip()
            if not (name or desc or content):
                continue
            head = f"- Skill: {name}" if name else "- Skill"
            if desc:
                head += f" — {desc}"
            lines = [head]
            if content:
                lines.append(f"  - {content}")
            out.append(Memory(text="\n".join(lines),
                              score=_clamp_score(s.get("relevanceScore")),
                              metadata=_meta("skill", owner_type, s.get("id"))))
    return out


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


class EverMeBackend:
    """Raven MemoryBackend implementation for EverMe cloud."""

    def __init__(self, ctx, *, client: Optional[EverMeClient] = None) -> None:
        self._cfg = resolve_config(dict(getattr(ctx, "config", None) or {}))
        self._logger = getattr(ctx, "logger", None) or logger
        if not self._cfg.get("agent_token"):
            # Fail construction loudly: a token-less backend would run the
            # whole session memory-less while looking installed. The
            # registry logs this and the operator re-runs
            # `evercli plugin install raven`.
            raise ValueError(
                "everme-memory: agent_token missing in plugins.config"
                '["everme-memory"] (and EVERME_AGENT_TOKEN unset); '
                "run `evercli plugin install raven`"
            )
        self._client = client or EverMeClient(self._cfg, version=_version())
        self._timeout_s = float(self._cfg.get("timeout_s") or 30.0)
        self._flush_every_turns = int(self._cfg.get("flush_every_turns") or 1)
        self._turn_counts: Dict[str, int] = {}
        self._profile_text = ""
        self._feedback_noop_logged = False

    # -- lifecycle -----------------------------------------------------

    async def start(self) -> None:
        self._logger.info(
            "EverMeBackend.start (api_base=%s, agent_id=%s)",
            self._cfg["api_base"], self._cfg.get("agent_id") or "<unset>",
        )
        # Warm the profile block for user-track recall (best-effort: a
        # cold cache costs one turn of profile context, not the boot).
        try:
            res = await self._request("POST", "/mem/context", {})
            self._profile_text = _render_profile(res)
        except Exception as e:
            self._logger.warning(
                "EverMeBackend.start: profile warm-up failed: %s", redact_error(e),
            )

    async def stop(self) -> None:
        self._logger.info("EverMeBackend.stop")
        # urllib client holds no pooled sockets; nothing to close.

    # -- MemoryBackend Protocol -----------------------------------------

    async def recall(
        self,
        query: str,
        *,
        user_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        top_k: int,
    ) -> List[Memory]:
        """Semantic recall via /mem/search, scoped by the evt identity.

        The EverMe agent token already binds (account, agent), so both
        tracks hit the same search endpoint; the track only tags
        Memory.metadata.owner_type and decides whether the warmed
        profile block is prepended (user track only). Exactly one of
        user_id / agent_id must be set (XOR) — same contract as the
        bundled everos-memory backend."""
        if (user_id is None) == (agent_id is None):
            self._logger.warning(
                "EverMeBackend.recall: expected exactly one of user_id / "
                "agent_id (got user_id=%r, agent_id=%r); returning empty",
                user_id, agent_id,
            )
            return []
        owner_type = "user" if user_id is not None else "agent"

        memories: List[Memory] = []
        q = (query or "").strip()[:_QUERY_MAX_CHARS]
        if len(q) >= _QUERY_MIN_CHARS:
            try:
                res = await self._request(
                    "POST", "/mem/search", {"query": q, "topK": max(1, int(top_k))},
                )
                memories = _search_to_memories(res, owner_type)
            except Exception as e:
                self._logger.warning(
                    "EverMeBackend.recall failed (%s); returning empty",
                    redact_error(e),
                )

        if owner_type == "user" and self._profile_text:
            memories.insert(0, Memory(
                text=self._profile_text,
                score=1.0,
                metadata={"type": "profile", "owner_type": "user"},
            ))
        return memories

    async def store(self, session_id: str, messages: List[Dict[str, Any]]) -> None:
        """Forward the turn's message slice to /mem/agent-memory.

        flush rides every Nth turn (flush_every_turns, default 1 — same
        cadence the Hermes provider uses) so short sessions still build
        memory. Failures are logged and swallowed: the turn is already
        in Raven's session log, only plugin-side indexing is skipped."""
        if not messages:
            return
        converted = _convert_messages(messages)
        if not converted:
            return
        n = self._turn_counts.get(session_id, 0) + 1
        self._turn_counts[session_id] = n
        flush = self._flush_every_turns > 0 and n % self._flush_every_turns == 0
        body = {"conversationId": session_id, "messages": converted, "flush": flush}
        try:
            await self._request("POST", "/mem/agent-memory", body)
        except Exception as e:
            self._logger.warning(
                "EverMeBackend.store failed (%s); turn not indexed",
                redact_error(e),
            )

    async def feedback(self, signals: Dict[str, Any]) -> None:
        """No EverMe sink for skill-usage signals yet (V2 Agent Hub
        scope); logged once per backend so the pending wiring stays
        visible without flooding the after-turn pipeline."""
        if not self._feedback_noop_logged:
            self._feedback_noop_logged = True
            self._logger.info(
                "EverMeBackend.feedback: no EverMe sink yet; signals "
                "dropped (keys=%s). Logged once per backend.",
                sorted(signals.keys()),
            )
        else:
            self._logger.debug(
                "EverMeBackend.feedback no-op (keys=%s)", sorted(signals.keys()),
            )

    # -- helpers ---------------------------------------------------------

    async def _request(self, method: str, path: str, body: Optional[dict]) -> Any:
        """Run the sync stdlib client off the event loop."""
        return await asyncio.to_thread(
            self._client.request, method, path, body, timeout=self._timeout_s,
        )


def _version() -> str:
    try:
        from . import __version__
        return __version__
    except Exception:
        return "0.0.0"
