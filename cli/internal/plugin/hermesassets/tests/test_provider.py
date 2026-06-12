import json
import unittest
from _fakes import install_fakes, make_everme_importable

install_fakes()
make_everme_importable()

from everme import EverMeMemoryProvider, register  # noqa: E402


class FakeClient:
    """Records calls; returns canned results or raises."""
    def __init__(self):
        self.calls = []
        self.fail = False
        self.results = {}
    def request(self, method, path, body=None, **kw):
        self.calls.append((method, path, body))
        if self.fail:
            from everme.client import EvermeError
            raise EvermeError("down", error_type="upstream")
        return self.results.get(path, None)


def make_provider(agent_context="primary", token="evt_x"):
    p = EverMeMemoryProvider()
    fc = FakeClient()
    # Inject config + client without network.
    p._cfg = {"api_base": "https://x/api/v1", "agent_id": "agt", "agent_token": token}
    p._client = fc
    p.initialize("sess-1", hermes_home="/tmp", agent_context=agent_context)
    p._client = fc  # initialize may rebuild; pin the fake
    return p, fc


class TestProviderCore(unittest.TestCase):
    def test_name(self):
        self.assertEqual(EverMeMemoryProvider().name, "everme")

    def test_is_available_requires_token(self):
        p = EverMeMemoryProvider()
        p._cfg = {"agent_token": ""}
        self.assertFalse(p.is_available())
        p._cfg = {"agent_token": "evt_x"}
        self.assertTrue(p.is_available())

    def test_is_available_resolves_home_before_initialize(self):
        import sys, tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "everme.env").write_text("EVERME_AGENT_TOKEN=evt_fromhome\n")
            # point the fake get_hermes_home at this dir
            orig = sys.modules["hermes_constants"].get_hermes_home
            sys.modules["hermes_constants"].get_hermes_home = lambda: Path(d)
            try:
                p = EverMeMemoryProvider()  # NOT initialized
                self.assertTrue(p.is_available())
            finally:
                sys.modules["hermes_constants"].get_hermes_home = orig

    def test_write_disabled_for_cron_context(self):
        p, _ = make_provider(agent_context="cron")
        self.assertFalse(p._write_enabled)

    def test_write_disabled_for_subagent(self):
        p, _ = make_provider(agent_context="subagent")
        self.assertFalse(p._write_enabled)

    def test_write_enabled_for_primary(self):
        p, _ = make_provider(agent_context="primary")
        self.assertTrue(p._write_enabled)

    def test_register_calls_ctx(self):
        seen = []
        class Ctx:
            def register_memory_provider(self, prov): seen.append(prov)
        register(Ctx())
        self.assertEqual(len(seen), 1)
        self.assertIsInstance(seen[0], EverMeMemoryProvider)

    def test_breaker_opens_after_threshold(self):
        p = EverMeMemoryProvider()
        for _ in range(5):
            p._record_failure()
        self.assertTrue(p._is_breaker_open())

    def test_breaker_resets_on_success(self):
        p = EverMeMemoryProvider()
        for _ in range(4):
            p._record_failure()
        p._record_success()
        self.assertFalse(p._is_breaker_open())

    def test_initialize_records_failure_on_context_error(self):
        p = EverMeMemoryProvider()
        fc = FakeClient()
        fc.fail = True
        p._cfg = {"api_base": "https://x/api/v1", "agent_id": "agt", "agent_token": "evt_x"}
        p._client = fc
        p.initialize("sess-1", hermes_home="/tmp", agent_context="primary")
        self.assertGreaterEqual(p._consecutive_failures, 1)


class TestPrefetch(unittest.TestCase):
    def test_queue_then_prefetch_returns_cached(self):
        p, fc = make_provider()
        # Real backend shape: items with episode + atomicFacts
        fc.results["/mem/search"] = {"items": [{"episode": "likes durian", "atomicFacts": []}]}
        p.queue_prefetch("food")
        if p._prefetch_thread:
            p._prefetch_thread.join(timeout=3.0)
        out = p.prefetch("food")
        self.assertIn("likes durian", out)
        # cache cleared after read
        self.assertEqual(p.prefetch("food"), "")

    def test_prefetch_query_truncated_to_1024(self):
        p, fc = make_provider()
        fc.results["/mem/search"] = {"items": []}
        p.queue_prefetch("x" * 5000)
        if p._prefetch_thread:
            p._prefetch_thread.join(timeout=3.0)
        sent = [c for c in fc.calls if c[1] == "/mem/search"][0]
        self.assertLessEqual(len(sent[2]["query"]), 1024)

    def test_queue_prefetch_skipped_when_breaker_open(self):
        p, fc = make_provider()
        for _ in range(5):
            p._record_failure()
        p.queue_prefetch("food")
        self.assertEqual(len([c for c in fc.calls if c[1] == "/mem/search"]), 0)

    def test_prefetch_returns_empty_when_breaker_open(self):
        p, fc = make_provider()
        fc.results["/mem/search"] = {"items": [{"episode": "cached", "atomicFacts": []}]}
        p.queue_prefetch("q")
        if p._prefetch_thread:
            p._prefetch_thread.join(timeout=3.0)
        for _ in range(5):
            p._record_failure()
        self.assertEqual(p.prefetch("q"), "")

    def test_prefetch_renders_atomic_facts(self):
        p, fc = make_provider()
        fc.results["/mem/search"] = {
            "items": [{"episode": "user is a dev", "atomicFacts": ["uses Python", "prefers dark mode"]}]
        }
        p.queue_prefetch("work")
        if p._prefetch_thread:
            p._prefetch_thread.join(timeout=3.0)
        out = p.prefetch("work")
        self.assertIn("user is a dev", out)
        self.assertIn("uses Python", out)
        self.assertIn("prefers dark mode", out)


class TestSyncTurn(unittest.TestCase):
    def _drain(self, p):
        if p._sync_thread:
            p._sync_thread.join(timeout=5.0)

    def test_sync_turn_posts_agent_memory(self):
        p, fc = make_provider()
        p.sync_turn("hi", "hello")
        self._drain(p)
        calls = [c for c in fc.calls if c[1] == "/mem/agent-memory"]
        self.assertEqual(len(calls), 1)
        body = calls[0][2]
        self.assertEqual(body["conversationId"], "sess-1")
        self.assertTrue(body["flush"])
        self.assertEqual(body["messages"][0]["role"], "user")
        self.assertEqual(body["messages"][1]["role"], "assistant")

    def test_sync_turn_skipped_when_write_disabled(self):
        p, fc = make_provider(agent_context="cron")
        p.sync_turn("hi", "hello")
        self._drain(p)
        self.assertEqual(len([c for c in fc.calls if c[1] == "/mem/agent-memory"]), 0)

    def test_sync_turn_failure_does_not_raise(self):
        p, fc = make_provider()
        fc.fail = True
        p.sync_turn("hi", "hello")  # must not raise
        self._drain(p)
        self.assertGreaterEqual(p._consecutive_failures, 1)

    def test_sync_turn_includes_timestamp(self):
        """Every message posted must carry an int timestamp > 0 (Bug 1)."""
        p, fc = make_provider()
        p.sync_turn("hi", "hello")
        self._drain(p)
        calls = [c for c in fc.calls if c[1] == "/mem/agent-memory"]
        self.assertEqual(len(calls), 1)
        for msg in calls[0][2]["messages"]:
            self.assertIn("timestamp", msg)
            self.assertIsInstance(msg["timestamp"], int)
            self.assertGreater(msg["timestamp"], 0)

    def test_sync_turn_preserves_tool_calls(self):
        """Tool calls in messages must be preserved in the POSTed body (Bug 3)."""
        p, fc = make_provider()
        messages = [
            {"role": "user", "content": "q", "timestamp": 1700000000000},
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "a"},
                    {"type": "toolCall", "id": "c1", "name": "grep", "arguments": {"q": "x"}},
                ],
            },
            {"role": "tool", "toolCallId": "c1", "content": "res"},
        ]
        p.sync_turn("", "", messages=messages)
        self._drain(p)
        calls = [c for c in fc.calls if c[1] == "/mem/agent-memory"]
        self.assertEqual(len(calls), 1)
        posted_msgs = calls[0][2]["messages"]
        self.assertEqual(len(posted_msgs), 3)
        # All messages have timestamp
        for msg in posted_msgs:
            self.assertIn("timestamp", msg)
            self.assertIsInstance(msg["timestamp"], int)
            self.assertGreater(msg["timestamp"], 0)
        # Assistant message has toolCalls
        asst = next(m for m in posted_msgs if m["role"] == "assistant")
        self.assertIn("toolCalls", asst)
        self.assertEqual(asst["toolCalls"][0]["name"], "grep")
        # Tool result message has toolCallId
        tool_msg = next(m for m in posted_msgs if m["role"] == "tool")
        self.assertEqual(tool_msg["toolCallId"], "c1")


    def test_sync_turn_honors_explicit_session_id(self):
        p, fc = make_provider()  # initialized with conversation "sess-1"
        p.sync_turn("hi", "hello", session_id="S_explicit")
        if p._sync_thread: p._sync_thread.join(timeout=5.0)
        body = [c for c in fc.calls if c[1] == "/mem/agent-memory"][0][2]
        self.assertEqual(body["conversationId"], "S_explicit")

    def test_sync_turn_openai_tool_call_shape_preserved(self):
        p, fc = make_provider()
        p.sync_turn("", "", session_id="S1", messages=[
            {"role": "assistant", "content": "ok",
             "tool_calls": [{"id": "c1", "type": "function",
                             "function": {"name": "grep", "arguments": "{\"q\":\"x\"}"}}]},
        ])
        if p._sync_thread: p._sync_thread.join(timeout=5.0)
        body = [c for c in fc.calls if c[1] == "/mem/agent-memory"][0][2]
        asst = [m for m in body["messages"] if m["role"] == "assistant"][0]
        self.assertEqual(asst["toolCalls"][0]["name"], "grep")
        self.assertEqual(asst["toolCalls"][0]["arguments"], "{\"q\":\"x\"}")

    def test_oversized_message_content_capped(self):
        p, fc = make_provider()
        big = "x" * 9000
        p.sync_turn("", "", session_id="S1", messages=[
            {"role": "user", "content": big, "timestamp": 1700000000000},
            {"role": "assistant", "content": big, "timestamp": 1700000000000},
        ])
        if p._sync_thread: p._sync_thread.join(timeout=5.0)
        body = [c for c in fc.calls if c[1] == "/mem/agent-memory"][0][2]
        for m in body["messages"]:
            self.assertLessEqual(len(m["content"]), 8000)

    def test_oversized_tool_content_capped(self):
        p, fc = make_provider()
        p.sync_turn("", "", session_id="S1", messages=[
            {"role": "user", "content": "q", "timestamp": 1700000000000},
            {"role": "assistant", "content": "a", "timestamp": 1700000000000},
            {"role": "tool", "tool_call_id": "c1", "content": "y" * 9000, "timestamp": 1700000000000},
        ])
        if p._sync_thread: p._sync_thread.join(timeout=5.0)
        body = [c for c in fc.calls if c[1] == "/mem/agent-memory"][0][2]
        tool = [m for m in body["messages"] if m["role"] == "tool"][0]
        self.assertLessEqual(len(tool["content"]), 8000)

    def test_sync_turn_trims_to_last_turn(self):
        p, fc = make_provider()
        msgs = [
            {"role": "user", "content": "first question", "timestamp": 1700000000000},
            {"role": "assistant", "content": "first answer", "timestamp": 1700000000000},
            {"role": "user", "content": "second question SENTINEL", "timestamp": 1700000001000},
            {"role": "assistant", "content": "second answer", "timestamp": 1700000001000},
        ]
        p.sync_turn("", "", session_id="S1", messages=msgs)
        if p._sync_thread: p._sync_thread.join(timeout=5.0)
        body = [c for c in fc.calls if c[1] == "/mem/agent-memory"][0][2]
        contents = [m.get("content") for m in body["messages"]]
        self.assertEqual(len(body["messages"]), 2)          # only the last turn
        self.assertIn("second question SENTINEL", contents)
        self.assertNotIn("first question", contents)
        self.assertTrue(body["flush"])                       # flush per turn

    def test_last_turn_helper(self):
        from everme import _last_turn
        msgs = [{"role": "user", "content": "u1"}, {"role": "assistant", "content": "a1"},
                {"role": "user", "content": "u2"}, {"role": "assistant", "content": "a2"},
                {"role": "tool", "toolCallId": "t", "content": "r"}]
        out = _last_turn(msgs)
        self.assertEqual([m["role"] for m in out], ["user", "assistant", "tool"])
        self.assertEqual(out[0]["content"], "u2")


class TestSessionHooks(unittest.TestCase):
    def _drain(self, p):
        if p._sync_thread:
            p._sync_thread.join(timeout=5.0)

    def test_session_end_is_noop(self):
        p, fc = make_provider()
        p.sync_turn("q1", "a1")
        self._drain(p)
        calls_after_sync = len([c for c in fc.calls if c[1] == "/mem/agent-memory"])
        p.on_session_end([{"role": "user", "content": "q1"}, {"role": "assistant", "content": "a1"}])
        self._drain(p)
        calls_after_end = len([c for c in fc.calls if c[1] == "/mem/agent-memory"])
        # on_session_end must post nothing additional
        self.assertEqual(calls_after_end, calls_after_sync)

    def test_session_end_noop_when_no_turns(self):
        p, fc = make_provider()
        p.on_session_end([])
        self._drain(p)
        self.assertEqual(len([c for c in fc.calls if c[1] == "/mem/agent-memory"]), 0)

    def test_session_switch_reset_updates_conversation_id(self):
        p, _ = make_provider()
        p.on_session_switch("sess-2", reset=True)
        self.assertEqual(p._conversation_id, "sess-2")

    def test_on_memory_write_user_target_posts_personal(self):
        p, fc = make_provider()
        p.on_memory_write("add", "user", "loves summer")
        p._flush_pending_facts()
        personal = [c for c in fc.calls if c[1] == "/mem/personal"]
        self.assertEqual(len(personal), 1)
        self.assertEqual(personal[0][2]["messages"][0]["content"], "loves summer")
        self.assertTrue(personal[0][2]["flush"])

    def test_on_memory_write_non_user_target_ignored(self):
        p, fc = make_provider()
        p.on_memory_write("add", "memory", "scratch note")
        p._flush_pending_facts()
        self.assertEqual(len([c for c in fc.calls if c[1] == "/mem/personal"]), 0)

    def test_on_memory_write_buffers_until_debounce(self):
        """No POST happens at write time — only the debounce flush posts."""
        p, fc = make_provider()
        p.on_memory_write("add", "user", "loves summer")
        self.assertEqual(len([c for c in fc.calls if c[1] == "/mem/personal"]), 0)
        self.assertIsNotNone(p._fact_timer)
        p._fact_timer.cancel()

    def test_on_memory_write_dedups_identical_content(self):
        """A model retry storm with identical text must collapse to one message."""
        p, fc = make_provider()
        p.on_memory_write("add", "user", "likes apples, dislikes kiwi")
        p.on_memory_write("update", "user", "likes apples, dislikes kiwi")
        p._flush_pending_facts()
        personal = [c for c in fc.calls if c[1] == "/mem/personal"]
        self.assertEqual(len(personal), 1)
        self.assertEqual(len(personal[0][2]["messages"]), 1)

    def test_on_memory_write_coalesces_burst_into_one_post(self):
        """Distinct facts written in a burst share ONE POST (one memcell upstream)."""
        p, fc = make_provider()
        p.on_memory_write("add", "user", "likes apples")
        p.on_memory_write("add", "user", "dislikes kiwi")
        p._flush_pending_facts()
        personal = [c for c in fc.calls if c[1] == "/mem/personal"]
        self.assertEqual(len(personal), 1)
        contents = [m["content"] for m in personal[0][2]["messages"]]
        self.assertEqual(contents, ["likes apples", "dislikes kiwi"])
        self.assertTrue(personal[0][2]["flush"])

    def test_flush_pending_facts_empty_buffer_posts_nothing(self):
        p, fc = make_provider()
        p._flush_pending_facts()
        self.assertEqual(len([c for c in fc.calls if c[1] == "/mem/personal"]), 0)

    def test_session_switch_flushes_pending_under_old_conversation(self):
        p, fc = make_provider()  # conversation "sess-1"
        p.on_memory_write("add", "user", "loves summer")
        p.on_session_switch("sess-2")
        if p._fact_thread:
            p._fact_thread.join(timeout=5.0)
        personal = [c for c in fc.calls if c[1] == "/mem/personal"]
        self.assertEqual(len(personal), 1)
        self.assertEqual(personal[0][2]["conversationId"], "sess-1")
        self.assertEqual(p._conversation_id, "sess-2")
        self.assertEqual(len(p._seen_facts), 0)  # dedup set is per session

    def test_session_switch_detaches_old_batch_before_new_write(self):
        """New-session facts must not append to an old-session flush batch."""
        p, fc = make_provider()  # conversation "sess-1"
        captured = []
        orig_start = p._start_fact_flush

        def capture_start(messages, cid):
            captured.append((messages, cid))

        p._start_fact_flush = capture_start
        p.on_memory_write("add", "user", "old fact")
        p.on_session_switch("sess-2")
        p.on_memory_write("add", "user", "new fact")

        self.assertEqual(len(captured), 1)
        self.assertEqual(captured[0][1], "sess-1")
        self.assertEqual([m["content"] for m in captured[0][0]], ["old fact"])

        p._start_fact_flush = orig_start
        p._flush_pending_facts()
        personal = [c for c in fc.calls if c[1] == "/mem/personal"]
        self.assertEqual(len(personal), 1)
        self.assertEqual(personal[0][2]["conversationId"], "sess-2")
        self.assertEqual([m["content"] for m in personal[0][2]["messages"]], ["new fact"])

    def test_batch_cid_stamped_at_enqueue_survives_id_reassignment(self):
        """A timer firing mid-switch must attribute facts to the session they
        were written in, not whatever _conversation_id holds at flush time."""
        p, fc = make_provider()  # conversation "sess-1"
        p.on_memory_write("add", "user", "loves summer")
        if p._fact_timer:
            p._fact_timer.cancel()
        p._conversation_id = "sess-2"  # simulate the racing reassignment
        p._flush_pending_facts()
        personal = [c for c in fc.calls if c[1] == "/mem/personal"]
        self.assertEqual(personal[0][2]["conversationId"], "sess-1")

    def test_batch_max_triggers_immediate_flush(self):
        from everme import _FACT_BATCH_MAX
        p, fc = make_provider()
        for i in range(_FACT_BATCH_MAX):
            p.on_memory_write("add", "user", f"fact-{i}")
        if p._fact_thread:
            p._fact_thread.join(timeout=5.0)
        personal = [c for c in fc.calls if c[1] == "/mem/personal"]
        self.assertEqual(len(personal), 1)
        self.assertEqual(len(personal[0][2]["messages"]), _FACT_BATCH_MAX)
        self.assertEqual(len(p._pending_facts), 0)

    def test_max_wait_deadline_clamps_debounce(self):
        """The per-write timer reset must not extend past the hard deadline."""
        from everme import _FACT_DEBOUNCE_SECS, _FACT_MAX_WAIT_SECS
        import time as _time
        p, _ = make_provider()
        p.on_memory_write("add", "user", "first fact")
        self.assertAlmostEqual(p._fact_timer.interval, _FACT_DEBOUNCE_SECS, delta=0.5)
        p._first_pending_at = _time.monotonic() - _FACT_MAX_WAIT_SECS  # deadline passed
        p.on_memory_write("add", "user", "second fact")
        self.assertEqual(p._fact_timer.interval, 0.0)
        if p._fact_timer:
            p._fact_timer.cancel()

    def test_flush_chunks_large_buffer(self):
        from everme import _FACT_BATCH_MAX
        p, fc = make_provider()
        p._pending_cid = "sess-1"
        p._pending_facts = [{"role": "user", "timestamp": 1700000000000, "content": f"f{i}"}
                            for i in range(2 * _FACT_BATCH_MAX + 50)]
        p._flush_pending_facts()
        personal = [c for c in fc.calls if c[1] == "/mem/personal"]
        self.assertEqual([len(c[2]["messages"]) for c in personal],
                         [_FACT_BATCH_MAX, _FACT_BATCH_MAX, 50])
        self.assertTrue(all(c[2]["flush"] for c in personal))

    def test_fact_flush_does_not_touch_sync_thread_slot(self):
        """Fact flush runs on its own slot; session switch never joins/clobbers
        the agent-memory _sync_thread (main loop must not block)."""
        p, fc = make_provider()
        p.sync_turn("q", "a")
        sync_thread = p._sync_thread
        p.on_memory_write("add", "user", "loves summer")
        p.on_session_switch("sess-2")
        self.assertIs(p._sync_thread, sync_thread)
        if p._fact_thread:
            p._fact_thread.join(timeout=5.0)
        self.assertEqual(len([c for c in fc.calls if c[1] == "/mem/personal"]), 1)

    def test_shutdown_flushes_pending_facts(self):
        p, fc = make_provider()
        p.on_memory_write("add", "user", "loves summer")
        p.shutdown()
        personal = [c for c in fc.calls if c[1] == "/mem/personal"]
        self.assertEqual(len(personal), 1)
        self.assertEqual(personal[0][2]["messages"][0]["content"], "loves summer")

    def test_on_memory_write_failure_does_not_raise(self):
        p, fc = make_provider()
        fc.fail = True
        p.on_memory_write("add", "user", "loves summer")
        p._flush_pending_facts()  # must not raise
        self.assertGreaterEqual(p._consecutive_failures, 1)

    def test_session_end_skipped_when_write_disabled(self):
        p, fc = make_provider(agent_context="cron")
        p.on_session_end([{"role": "user", "content": "q"}])
        self._drain(p)
        self.assertEqual(len([c for c in fc.calls if c[1] == "/mem/agent-memory"]), 0)

    def test_personal_message_has_timestamp(self):
        """on_memory_write must include timestamp in the user message (Bug 1)."""
        p, fc = make_provider()
        p.on_memory_write("add", "user", "loves summer")
        p._flush_pending_facts()
        personal = [c for c in fc.calls if c[1] == "/mem/personal"]
        self.assertEqual(len(personal), 1)
        msg = personal[0][2]["messages"][0]
        self.assertIn("timestamp", msg)
        self.assertIsInstance(msg["timestamp"], int)
        self.assertGreater(msg["timestamp"], 0)

    def test_oversized_fact_capped(self):
        p, fc = make_provider()
        p.on_memory_write("add", "user", "z" * 9000)
        p._flush_pending_facts()
        body = [c for c in fc.calls if c[1] == "/mem/personal"][0][2]
        self.assertLessEqual(len(body["messages"][0]["content"]), 8000)


class TestTools(unittest.TestCase):
    def test_exposes_two_readonly_tools(self):
        names = {s["name"] for s in EverMeMemoryProvider().get_tool_schemas()}
        self.assertEqual(names, {"mem_search", "mem_context"})

    def test_search_dispatch(self):
        p, fc = make_provider()
        # Real backend shape: episode + atomicFacts
        fc.results["/mem/search"] = {"items": [{"episode": "likes durian", "atomicFacts": []}]}
        out = json.loads(p.handle_tool_call("mem_search", {"query": "q"}))
        self.assertIn("likes durian", json.dumps(out))
        self.assertEqual([c for c in fc.calls if c[1] == "/mem/search"][0][2]["query"], "q")

    def test_context_dispatch_renders_profile(self):
        p, fc = make_provider()
        # Real backend shape: profile with explicit_info + implicit_traits
        fc.results["/mem/context"] = {
            "profile": {
                "explicit_info": [{"category": "Preferences", "description": "loves summer"}],
                "implicit_traits": [],
            }
        }
        out = json.loads(p.handle_tool_call("mem_context", {}))
        self.assertIn("loves summer", json.dumps(out))

    def test_save_fact_tool_removed(self):
        """mem_save_fact is gone — on_memory_write owns /mem/personal now."""
        p, fc = make_provider()
        out = json.loads(p.handle_tool_call("mem_save_fact", {"fact": "loves durian"}))
        self.assertIn("error", out)
        self.assertEqual(len([c for c in fc.calls if c[1] == "/mem/personal"]), 0)

    def test_search_missing_query_returns_error(self):
        p, _ = make_provider()
        out = json.loads(p.handle_tool_call("mem_search", {}))
        self.assertIn("error", out)

    def test_unknown_tool_returns_error(self):
        p, _ = make_provider()
        out = json.loads(p.handle_tool_call("mem_bogus", {}))
        self.assertIn("error", out)

    def test_breaker_open_returns_unavailable(self):
        p, _ = make_provider()
        for _ in range(5):
            p._record_failure()
        out = json.loads(p.handle_tool_call("mem_search", {"query": "q"}))
        self.assertIn("error", out)


class TestRenderHelpers(unittest.TestCase):
    """Unit tests for the module-level render helpers (Bug 2)."""

    def test_render_search_episode_and_facts(self):
        from everme import _render_search
        res = {
            "items": [
                {"episode": "user likes durian", "atomicFacts": ["eats durian weekly", "buys from Asian market"]},
            ]
        }
        out = _render_search(res)
        self.assertIn("user likes durian", out)
        self.assertIn("eats durian weekly", out)
        self.assertIn("buys from Asian market", out)

    def test_render_search_empty_items(self):
        from everme import _render_search
        self.assertEqual(_render_search({"items": []}), "")

    def test_render_search_non_dict_input(self):
        from everme import _render_search
        self.assertEqual(_render_search(None), "")
        self.assertEqual(_render_search("string"), "")

    def test_render_search_item_missing_episode(self):
        from everme import _render_search
        # Item with no episode but has atomicFacts — episode line skipped, facts skipped too
        res = {"items": [{"episode": "", "atomicFacts": ["some fact"]}]}
        out = _render_search(res)
        # episode is empty so no episode line; atomicFacts are indented under episode so also skipped
        self.assertNotIn("some fact", out)

    def test_render_profile_explicit_info(self):
        from everme import _render_profile
        res = {
            "profile": {
                "explicit_info": [{"category": "Preferences", "description": "loves summer"}],
                "implicit_traits": [],
            }
        }
        out = _render_profile(res)
        self.assertIn("loves summer", out)
        self.assertIn("[Preferences]", out)

    def test_render_profile_implicit_traits(self):
        from everme import _render_profile
        res = {
            "profile": {
                "explicit_info": [],
                "implicit_traits": [{"trait": "curious", "description": "asks many questions"}],
            }
        }
        out = _render_profile(res)
        self.assertIn("curious", out)
        self.assertIn("asks many questions", out)

    def test_render_profile_no_category(self):
        from everme import _render_profile
        res = {
            "profile": {
                "explicit_info": [{"description": "no category here"}],
                "implicit_traits": [],
            }
        }
        out = _render_profile(res)
        self.assertIn("no category here", out)
        self.assertNotIn("[None]", out)

    def test_render_profile_non_dict_input(self):
        from everme import _render_profile
        self.assertEqual(_render_profile(None), "")
        self.assertEqual(_render_profile("string"), "")

    def test_render_profile_nested_profile_key(self):
        from everme import _render_profile
        # Response wraps profile under "profile" key
        res = {"profile": {"explicit_info": [{"category": "Food", "description": "likes spicy"}], "implicit_traits": []}}
        out = _render_profile(res)
        self.assertIn("likes spicy", out)

    def test_render_profile_direct_dict(self):
        from everme import _render_profile
        # Profile passed directly (no outer "profile" key)
        res = {"explicit_info": [{"category": "Food", "description": "likes spicy"}], "implicit_traits": []}
        out = _render_profile(res)
        self.assertIn("likes spicy", out)


class TestConvertAgentMessages(unittest.TestCase):
    """Unit tests for the _convert_agent_messages helper (Bug 3)."""

    def test_user_message_preserved(self):
        from everme import _convert_agent_messages
        msgs = [{"role": "user", "content": "hello", "timestamp": 1700000000000}]
        out = _convert_agent_messages(msgs)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["role"], "user")
        self.assertEqual(out[0]["content"], "hello")
        self.assertEqual(out[0]["timestamp"], 1700000000000)

    def test_assistant_text_preserved(self):
        from everme import _convert_agent_messages
        msgs = [{"role": "assistant", "content": "world"}]
        out = _convert_agent_messages(msgs)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["content"], "world")

    def test_assistant_tool_call_in_content_list(self):
        from everme import _convert_agent_messages
        msgs = [{
            "role": "assistant",
            "content": [
                {"type": "text", "text": "I'll search"},
                {"type": "toolCall", "id": "tc1", "name": "grep", "arguments": {"q": "x"}},
            ],
        }]
        out = _convert_agent_messages(msgs)
        self.assertEqual(len(out), 1)
        asst = out[0]
        self.assertIn("toolCalls", asst)
        self.assertEqual(asst["toolCalls"][0]["name"], "grep")
        self.assertEqual(asst["toolCalls"][0]["id"], "tc1")

    def test_tool_result_message_preserved(self):
        from everme import _convert_agent_messages
        msgs = [{"role": "tool", "toolCallId": "tc1", "content": "result text"}]
        out = _convert_agent_messages(msgs)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["role"], "tool")
        self.assertEqual(out[0]["toolCallId"], "tc1")
        self.assertEqual(out[0]["content"], "result text")

    def test_tool_result_without_toolcallid_dropped(self):
        from everme import _convert_agent_messages
        msgs = [{"role": "tool", "content": "orphan"}]
        out = _convert_agent_messages(msgs)
        self.assertEqual(len(out), 0)

    def test_all_messages_have_timestamp(self):
        from everme import _convert_agent_messages
        msgs = [
            {"role": "user", "content": "q"},
            {"role": "assistant", "content": "a"},
        ]
        out = _convert_agent_messages(msgs)
        for m in out:
            self.assertIn("timestamp", m)
            self.assertIsInstance(m["timestamp"], int)
            self.assertGreater(m["timestamp"], 0)

    def test_epoch_seconds_coerced_to_ms(self):
        from everme import _coerce_ts
        # Seconds-scale value should be multiplied by 1000
        result = _coerce_ts(1700000000)
        self.assertEqual(result, 1700000000000)

    def test_epoch_ms_kept_as_is(self):
        from everme import _coerce_ts
        result = _coerce_ts(1700000000000)
        self.assertEqual(result, 1700000000000)

    def test_none_ts_returns_current_ms(self):
        import time
        from everme import _coerce_ts
        before = int(time.time() * 1000)
        result = _coerce_ts(None)
        after = int(time.time() * 1000)
        self.assertGreaterEqual(result, before)
        self.assertLessEqual(result, after)

    def test_pre_extracted_tool_calls_merged(self):
        from everme import _convert_agent_messages
        msgs = [{
            "role": "assistant",
            "content": "calling tool",
            "toolCalls": [{"id": "x1", "name": "run", "arguments": "{}"}],
        }]
        out = _convert_agent_messages(msgs)
        self.assertEqual(len(out), 1)
        self.assertIn("toolCalls", out[0])
        self.assertEqual(out[0]["toolCalls"][0]["name"], "run")

    def test_openai_tool_call_function_nesting(self):
        """OpenAI shape: tool_calls[*].function.{name,arguments} must be read."""
        from everme import _convert_agent_messages
        msgs = [{
            "role": "assistant",
            "content": "ok",
            "tool_calls": [{"id": "c1", "type": "function",
                            "function": {"name": "grep", "arguments": "{\"q\":\"x\"}"}}],
        }]
        out = _convert_agent_messages(msgs)
        self.assertEqual(len(out), 1)
        self.assertIn("toolCalls", out[0])
        self.assertEqual(out[0]["toolCalls"][0]["name"], "grep")
        self.assertEqual(out[0]["toolCalls"][0]["arguments"], "{\"q\":\"x\"}")


class TestConfigSchema(unittest.TestCase):
    def test_config_schema_has_secret_token_field(self):
        schema = EverMeMemoryProvider().get_config_schema()
        token = [f for f in schema if f["key"] == "agent_token"][0]
        self.assertTrue(token["secret"])
        self.assertEqual(token["env_var"], "EVERME_AGENT_TOKEN")
        self.assertTrue(token["required"])


if __name__ == "__main__":
    unittest.main()
