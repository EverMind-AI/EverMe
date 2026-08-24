import os
import unittest

from _fakes import install_fakes, make_plugin_importable

install_fakes()
make_plugin_importable()

from everme_raven import config as cfgmod  # noqa: E402


class TestConfig(unittest.TestCase):
    def setUp(self):
        for k in ("EVERME_API_BASE", "EVERME_AGENT_ID", "EVERME_AGENT_TOKEN"):
            os.environ.pop(k, None)

    def test_default_api_base_gets_v1_prefix(self):
        c = cfgmod.resolve_config({})
        self.assertEqual(c["api_base"], "https://api.everme.evermind.ai/api/v1")

    def test_config_dict_wins_over_env(self):
        os.environ["EVERME_AGENT_TOKEN"] = "evt_env" + "a" * 32
        c = cfgmod.resolve_config({"agent_token": "evt_cfg" + "b" * 32})
        self.assertEqual(c["agent_token"], "evt_cfg" + "b" * 32)

    def test_env_fills_missing_config_keys(self):
        os.environ["EVERME_AGENT_TOKEN"] = "evt_" + "a" * 32
        os.environ["EVERME_AGENT_ID"] = "agt_x"
        c = cfgmod.resolve_config({"api_base": "https://custom.example"})
        self.assertEqual(c["agent_token"], "evt_" + "a" * 32)
        self.assertEqual(c["agent_id"], "agt_x")
        self.assertEqual(c["api_base"], "https://custom.example/api/v1")

    def test_api_base_existing_v1_suffix_not_doubled(self):
        c = cfgmod.resolve_config({"api_base": "https://x/api/v1/"})
        self.assertEqual(c["api_base"], "https://x/api/v1")

    def test_none_config_ok(self):
        c = cfgmod.resolve_config(None)
        self.assertEqual(c["flush_every_turns"], 1)
        self.assertEqual(c["timeout_s"], 30.0)

    def test_numeric_coercion_and_bad_values(self):
        c = cfgmod.resolve_config({"flush_every_turns": "5", "timeout_s": "2.5"})
        self.assertEqual(c["flush_every_turns"], 5)
        self.assertEqual(c["timeout_s"], 2.5)
        c = cfgmod.resolve_config({"flush_every_turns": "x", "timeout_s": {}})
        self.assertEqual(c["flush_every_turns"], 1)
        self.assertEqual(c["timeout_s"], 30.0)


if __name__ == "__main__":
    unittest.main()
