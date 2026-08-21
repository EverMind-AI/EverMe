import asyncio
import unittest

from _fakes import FakeContext, install_fakes, make_plugin_importable

install_fakes()
make_plugin_importable()

from everme_raven import backend as backendmod  # noqa: E402
from everme_raven.client import EvermeError  # noqa: E402

TOKEN = "evt_" + "a" * 32


class FakeClient:
    """Records request() calls; responses are canned per path."""

    def __init__(self, responses=None, error=None):
        self.calls = []
        self.responses = responses or {}
        self.error = error

    def request(self, method, path, body=None, *, timeout=30.0, query=None):
        self.calls.append({"method": method, "path": path, "body": body})
        if self.error is not None:
            raise self.error
        return self.responses.get(path)


def make_backend(config=None, client=None):
    cfg = {"agent_token": TOKEN, "agent_id": "agt_1"}
    cfg.update(config or {})
    return backendmod.EverMeBackend(FakeContext(config=cfg), client=client)


def run(coro):
    return asyncio.run(coro)


class TestConstruction(unittest.TestCase):
    def test_missing_token_fails_loudly(self):
        with self.assertRaises(ValueError) as ctx:
            backendmod.EverMeBackend(FakeContext(config={}))
        self.assertIn("evercli plugin install raven", str(ctx.exception))

    def test_make_backend_factory(self):
        b = backendmod.make_backend(FakeContext(config={"agent_token": TOKEN}))
        self.assertIsInstance(b, backendmod.EverMeBackend)


class TestRecall(unittest.TestCase):
    def _search_result(self):
        # relevanceScore is the real BFF field name (SearchResultItem json
        # tag). The earlier "score" fake masked a field-name bug that left
        # every recalled episode at score 0 in production.
        return {"items": [
            {"episode": "User likes durian", "atomicFacts": ["likes durian"],
             "relevanceScore": 0.8, "id": "mem_1"},
            {"episode": "", "atomicFacts": ["orphan"]},  # dropped: no episode
            {"episode": "Summer is the favorite season", "relevanceScore": 7},  # clamped
        ]}

    def test_xor_violation_returns_empty(self):
        fc = FakeClient()
        b = make_backend(client=fc)
        self.assertEqual(run(b.recall("query", top_k=5)), [])
        self.assertEqual(
            run(b.recall("query", user_id="u", agent_id="a", top_k=5)), [])
        self.assertEqual(fc.calls, [])

    def test_user_track_maps_items_to_memories(self):
        fc = FakeClient(responses={"/mem/search": self._search_result()})
        b = make_backend(client=fc)
        out = run(b.recall("what fruit", user_id="u1", top_k=5))
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0].text, "- User likes durian\n  - likes durian")
        self.assertAlmostEqual(out[0].score, 0.8)
        self.assertEqual(out[0].metadata["id"], "mem_1")
        self.assertEqual(out[0].metadata["owner_type"], "user")
        self.assertEqual(out[1].score, 1.0)  # 7 clamped to [0, 1]
        self.assertEqual(fc.calls[0]["path"], "/mem/search")
        self.assertEqual(fc.calls[0]["body"], {"query": "what fruit", "topK": 5})

    def test_agent_memory_cases_and_skills_surface(self):
        # /mem/search returns data.agent_memory.{cases,skills} alongside the
        # episodic items. recall() must render them too — an agent that wrote
        # trajectories via /mem/agent-memory has to be able to recall the
        # cases/skills those writes produced, not just episodes.
        res = {
            "items": [{"episode": "Wrote and ran factorial.py -> 720",
                       "relevanceScore": 0.5, "id": "e1"}],
            "agentMemory": {
                "cases": [{
                    "id": "case_1",
                    "taskIntent": "Write and run a Python script that computes a value",
                    "approach": "created the file, ran python3, reported the output",
                    "relevanceScore": 0.6,
                }],
                "skills": [{
                    "id": "skill_1",
                    "name": "write-and-run-python-script",
                    "description": "Author a small Python script and execute it",
                    "content": "1. write file  2. run python3 file  3. report output",
                    "relevanceScore": 0.7,
                }],
            },
        }
        fc = FakeClient(responses={"/mem/search": res})
        b = make_backend(client=fc)
        out = run(b.recall("python task", agent_id="agt_1", top_k=10))

        by_type = {m.metadata["type"]: m for m in out}
        self.assertIn("episode", by_type)
        self.assertIn("case", by_type)
        self.assertIn("skill", by_type)

        case = by_type["case"]
        self.assertIn("Write and run a Python script", case.text)
        self.assertIn("created the file", case.text)
        self.assertEqual(case.metadata["id"], "case_1")
        self.assertEqual(case.metadata["owner_type"], "agent")
        self.assertAlmostEqual(case.score, 0.6)

        skill = by_type["skill"]
        self.assertIn("write-and-run-python-script", skill.text)
        self.assertIn("run python3 file", skill.text)
        self.assertEqual(skill.metadata["id"], "skill_1")
        self.assertAlmostEqual(skill.score, 0.7)

    def test_agent_memory_absent_or_empty_is_safe(self):
        # No agentMemory key, and an empty one, must both render cleanly.
        for res in ({"items": []}, {"items": [], "agentMemory": {}},
                    {"items": [], "agentMemory": {"cases": [], "skills": []}}):
            fc = FakeClient(responses={"/mem/search": res})
            b = make_backend(client=fc)
            self.assertEqual(run(b.recall("q", agent_id="agt_1", top_k=5)), [])

    def test_profile_prepended_on_user_track_after_start(self):
        fc = FakeClient(responses={
            "/mem/context": {"profile": {"explicit_info": [
                {"category": "food", "description": "likes durian"}]}},
            "/mem/search": self._search_result(),
        })
        b = make_backend(client=fc)
        run(b.start())
        out = run(b.recall("what fruit", user_id="u1", top_k=5))
        self.assertEqual(out[0].metadata["type"], "profile")
        self.assertEqual(out[0].text, "- [food] likes durian")
        self.assertEqual(out[0].score, 1.0)
        # agent track never gets the profile block
        out_agent = run(b.recall("what fruit", agent_id="agt_1", top_k=5))
        self.assertTrue(all(m.metadata["type"] != "profile" for m in out_agent))

    def test_short_query_skips_search_but_keeps_profile(self):
        fc = FakeClient(responses={
            "/mem/context": {"profile": {"explicit_info": [
                {"description": "likes durian"}]}},
        })
        b = make_backend(client=fc)
        run(b.start())
        out = run(b.recall("hi", user_id="u1", top_k=5))
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].metadata["type"], "profile")
        self.assertEqual([c["path"] for c in fc.calls], ["/mem/context"])

    def test_search_failure_swallowed(self):
        fc = FakeClient(error=EvermeError("boom"))
        b = make_backend(client=fc)
        self.assertEqual(run(b.recall("what fruit", user_id="u1", top_k=5)), [])

    def test_start_profile_failure_swallowed(self):
        fc = FakeClient(error=EvermeError("boom"))
        b = make_backend(client=fc)
        run(b.start())  # must not raise


class TestStore(unittest.TestCase):
    def test_converts_and_posts_turn_slice(self):
        fc = FakeClient()
        b = make_backend(client=fc)
        run(b.store("sess-1", [
            {"role": "system", "content": "ignored"},
            {"role": "user", "content": "hello", "timestamp": 1751500000000},
            {"role": "assistant", "content": "hi", "tool_calls": [
                {"id": "tc1", "function": {"name": "grep", "arguments": '{"q":"x"}'}}]},
            {"role": "tool", "tool_call_id": "tc1", "content": "match"},
        ]))
        self.assertEqual(len(fc.calls), 1)
        body = fc.calls[0]["body"]
        self.assertEqual(fc.calls[0]["path"], "/mem/agent-memory")
        self.assertEqual(body["conversationId"], "sess-1")
        self.assertTrue(body["flush"])
        msgs = body["messages"]
        self.assertEqual([m["role"] for m in msgs], ["user", "assistant", "tool"])
        self.assertEqual(msgs[0]["timestamp"], 1751500000000)
        self.assertEqual(msgs[1]["toolCalls"][0]["name"], "grep")
        self.assertEqual(msgs[1]["toolCalls"][0]["arguments"], '{"q":"x"}')
        self.assertEqual(msgs[2]["toolCallId"], "tc1")
        for m in msgs:
            self.assertIsInstance(m["timestamp"], int)
            self.assertGreater(m["timestamp"], 10_000_000_000)

    def test_flush_cadence_follows_config(self):
        fc = FakeClient()
        b = make_backend(config={"flush_every_turns": 2}, client=fc)
        turn = [{"role": "user", "content": "hello"}]
        run(b.store("sess-1", turn))
        run(b.store("sess-1", turn))
        run(b.store("sess-2", turn))  # independent per-session counter
        self.assertEqual([c["body"]["flush"] for c in fc.calls],
                         [False, True, False])

    def test_empty_or_unconvertible_slice_skips_post(self):
        fc = FakeClient()
        b = make_backend(client=fc)
        run(b.store("sess-1", []))
        run(b.store("sess-1", [{"role": "system", "content": "x"}]))
        self.assertEqual(fc.calls, [])

    def test_store_failure_swallowed(self):
        fc = FakeClient(error=EvermeError("boom"))
        b = make_backend(client=fc)
        run(b.store("sess-1", [{"role": "user", "content": "hello"}]))  # must not raise

    def test_content_capped(self):
        fc = FakeClient()
        b = make_backend(client=fc)
        run(b.store("sess-1", [{"role": "user", "content": "x" * 10000}]))
        self.assertEqual(
            len(fc.calls[0]["body"]["messages"][0]["content"]), 8000)


class TestConvert(unittest.TestCase):
    def test_seconds_timestamp_coerced_to_ms(self):
        out = backendmod._convert_messages(
            [{"role": "user", "content": "x", "timestamp": 1751500000.5}])
        self.assertEqual(out[0]["timestamp"], 1751500000500)

    def test_content_block_tool_use_preserved(self):
        out = backendmod._convert_messages([{
            "role": "assistant",
            "content": [
                {"type": "text", "text": "let me check"},
                {"type": "tool_use", "id": "tc9", "name": "read",
                 "input": {"path": "/tmp/x"}},
            ],
        }])
        self.assertEqual(out[0]["content"], "let me check")
        self.assertEqual(out[0]["toolCalls"][0]["id"], "tc9")
        self.assertIn('"path"', out[0]["toolCalls"][0]["arguments"])

    def test_tool_result_without_call_id_dropped(self):
        out = backendmod._convert_messages(
            [{"role": "tool", "content": "orphan"}])
        self.assertEqual(out, [])


class TestFeedback(unittest.TestCase):
    def test_noop_does_not_raise(self):
        b = make_backend(client=FakeClient())
        run(b.feedback({"kind": "skill_usage"}))
        run(b.feedback({"kind": "skill_usage"}))
        self.assertTrue(b._feedback_noop_logged)


if __name__ == "__main__":
    unittest.main()
