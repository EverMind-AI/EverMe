import json
import unittest
from _fakes import install_fakes, make_everme_importable

install_fakes()
make_everme_importable()

from everme import client as clientmod  # noqa: E402


class FakeResponse:
    def __init__(self, body, status=200):
        self._body = body.encode() if isinstance(body, str) else body
        self.status = status
    def read(self): return self._body
    def __enter__(self): return self
    def __exit__(self, *a): return False


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

    def test_bearer_header_set(self):
        captured = {}
        def opener(req, timeout):
            captured["auth"] = req.get_header("Authorization")
            return FakeResponse(json.dumps({"status": 0, "result": None}))
        self._client(opener).request("POST", "/mem/context", {})
        self.assertEqual(captured["auth"], "Bearer evt_tok")


class TestRetry(unittest.TestCase):
    def _client(self, opener):
        cfg = {"api_base": "https://x/api/v1", "agent_id": "agt", "agent_token": "evt_tok"}
        return clientmod.EverMeClient(cfg, opener=opener)

    def test_get_retries_once_on_transport_error(self):
        calls = {"n": 0}
        def opener(req, timeout):
            calls["n"] += 1
            raise OSError("boom")
        with self.assertRaises(clientmod.EvermeError):
            self._client(opener).request("GET", "/mem/search")
        self.assertEqual(calls["n"], 2)

    def test_post_not_retried_on_transport_error(self):
        calls = {"n": 0}
        def opener(req, timeout):
            calls["n"] += 1
            raise OSError("boom")
        with self.assertRaises(clientmod.EvermeError):
            self._client(opener).request("POST", "/mem/search", {"query": "q"})
        self.assertEqual(calls["n"], 1)

    def test_get_does_not_retry_on_application_error(self):
        calls = {"n": 0}
        def opener(req, timeout):
            calls["n"] += 1
            return FakeResponse(json.dumps({"status": 30001, "error": "no"}))
        with self.assertRaises(clientmod.EvermeError):
            self._client(opener).request("GET", "/mem/search")
        self.assertEqual(calls["n"], 1)

    def test_transport_error_suppresses_exception_context(self):
        def opener(req, timeout):
            raise OSError("evt_" + "z" * 40 + " in url")
        try:
            self._client(opener).request("POST", "/mem/x", {"a": 1})
            self.fail("expected EvermeError")
        except clientmod.EvermeError as err:
            self.assertTrue(err.__suppress_context__)
            self.assertNotIn("z" * 40, str(err))

    def test_success_result_none_returns_none(self):
        def opener(req, timeout):
            return FakeResponse(json.dumps({"status": 0, "result": None}))
        self.assertIsNone(self._client(opener).request("POST", "/mem/context", {}))


if __name__ == "__main__":
    unittest.main()
