import json
import unittest

from _fakes import install_fakes, make_plugin_importable

install_fakes()
make_plugin_importable()

from everme_raven import client as clientmod  # noqa: E402


class FakeResponse:
    def __init__(self, body, status=200):
        self._body = body.encode() if isinstance(body, str) else body
        self.status = status

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class TestRedact(unittest.TestCase):
    def test_redacts_evt_token(self):
        msg = "boom evt_" + "a" * 32 + " tail"
        self.assertNotIn("a" * 32, clientmod.redact_error(msg))
        self.assertIn("evt_", clientmod.redact_error(msg))

    def test_redacts_emk_token(self):
        msg = "emk_" + "b" * 32
        self.assertNotIn("b" * 32, clientmod.redact_error(msg))


class TestEnvelope(unittest.TestCase):
    def _client(self, opener):
        cfg = {"api_base": "https://x/api/v1", "agent_id": "agt", "agent_token": "evt_tok"}
        return clientmod.EverMeClient(cfg, opener=opener)

    def test_status_zero_returns_result(self):
        def opener(req, timeout):
            return FakeResponse(json.dumps({"status": 0, "result": {"ok": True}}))
        c = self._client(opener)
        self.assertEqual(c.request("POST", "/mem/search", {"query": "q"}), {"ok": True})

    def test_nonzero_status_raises_typed_error(self):
        def opener(req, timeout):
            return FakeResponse(json.dumps({"status": 30001, "error": "nope", "requestId": "r1"}))
        c = self._client(opener)
        with self.assertRaises(clientmod.EvermeError) as ctx:
            c.request("POST", "/mem/search", {"query": "q"})
        self.assertEqual(ctx.exception.code, 30001)
        self.assertEqual(ctx.exception.type, "auth")

    def test_bearer_and_user_agent_headers_set(self):
        captured = {}

        def opener(req, timeout):
            captured["auth"] = req.get_header("Authorization")
            captured["ua"] = req.get_header("User-agent")
            return FakeResponse(json.dumps({"status": 0, "result": None}))
        self._client(opener).request("POST", "/mem/context", {})
        self.assertEqual(captured["auth"], "Bearer evt_tok")
        self.assertIn("everme-raven-plugin/", captured["ua"])


class TestRetry(unittest.TestCase):
    def _client(self, opener):
        cfg = {"api_base": "https://x/api/v1", "agent_token": "evt_tok"}
        return clientmod.EverMeClient(cfg, opener=opener)

    def test_get_retries_once_on_transport_error(self):
        calls = {"n": 0}

        def opener(req, timeout):
            calls["n"] += 1
            if calls["n"] == 1:
                raise OSError("conn reset")
            return FakeResponse(json.dumps({"status": 0, "result": "ok"}))
        c = self._client(opener)
        self.assertEqual(c.request("GET", "/health"), "ok")
        self.assertEqual(calls["n"], 2)

    def test_post_never_retried(self):
        calls = {"n": 0}

        def opener(req, timeout):
            calls["n"] += 1
            raise OSError("conn reset")
        c = self._client(opener)
        with self.assertRaises(clientmod.EvermeError):
            c.request("POST", "/mem/agent-memory", {"messages": []})
        self.assertEqual(calls["n"], 1)


if __name__ == "__main__":
    unittest.main()
