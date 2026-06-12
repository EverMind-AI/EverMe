import os
import unittest
import tempfile
from pathlib import Path
from _fakes import install_fakes, make_everme_importable

install_fakes()
make_everme_importable()

from everme import config as cfgmod  # noqa: E402


class TestConfig(unittest.TestCase):
    def setUp(self):
        for k in ("EVERME_API_BASE", "EVERME_AGENT_ID", "EVERME_AGENT_TOKEN"):
            os.environ.pop(k, None)

    def test_default_api_base_gets_v1_prefix(self):
        c = cfgmod.resolve_config(hermes_home="/nonexistent")
        self.assertEqual(c["api_base"], "https://api.everme.evermind.ai/api/v1")

    def test_env_overrides_default(self):
        os.environ["EVERME_AGENT_TOKEN"] = "evt_" + "a" * 32
        os.environ["EVERME_AGENT_ID"] = "agt_x"
        c = cfgmod.resolve_config(hermes_home="/nonexistent")
        self.assertEqual(c["agent_token"], "evt_" + "a" * 32)
        self.assertEqual(c["agent_id"], "agt_x")

    def test_env_file_read_when_env_absent(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "everme.env").write_text(
                "EVERME_AGENT_TOKEN=evt_fromfile\nEVERME_AGENT_ID=agt_file\n"
            )
            c = cfgmod.resolve_config(hermes_home=d)
            self.assertEqual(c["agent_token"], "evt_fromfile")
            self.assertEqual(c["agent_id"], "agt_file")

    def test_process_env_wins_over_env_file(self):
        os.environ["EVERME_AGENT_TOKEN"] = "evt_fromproc"
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "everme.env").write_text("EVERME_AGENT_TOKEN=evt_fromfile\n")
            c = cfgmod.resolve_config(hermes_home=d)
            self.assertEqual(c["agent_token"], "evt_fromproc")

    def test_explicit_api_base_with_v1_not_double_prefixed(self):
        os.environ["EVERME_API_BASE"] = "https://dev.example.com/api/v1"
        c = cfgmod.resolve_config(hermes_home="/nonexistent")
        self.assertEqual(c["api_base"], "https://dev.example.com/api/v1")


if __name__ == "__main__":
    unittest.main()
