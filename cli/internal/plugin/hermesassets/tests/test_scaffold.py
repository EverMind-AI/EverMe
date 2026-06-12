import unittest
from _fakes import install_fakes, make_everme_importable

install_fakes()
make_everme_importable()


class TestScaffold(unittest.TestCase):
    def test_everme_package_imports(self):
        import everme  # noqa: F401

    def test_fake_memory_provider_available(self):
        from agent.memory_provider import MemoryProvider
        self.assertTrue(hasattr(MemoryProvider, "sync_turn"))


if __name__ == "__main__":
    unittest.main()
