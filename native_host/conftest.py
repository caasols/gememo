"""pytest configuration for the native-host tests.

Hermetic-isolation fixtures so the suite never touches the user's real cache.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import meeting_minutes_host as mh


@pytest.fixture(autouse=True)
def _isolate_heartbeat(tmp_path, monkeypatch):
    """Redirect the BUG-9 stage heartbeat to a per-test temp file.

    Many tests drive ``main()`` directly, which emits ``_heartbeat(...)`` lines.
    Without this, every test run would append to the real
    ``~/.cache/mm2c/host_heartbeat.log`` and pollute the live diagnostic trail.
    Tests that need to assert on the heartbeat (test_heartbeat, test_main_flow)
    patch ``HEARTBEAT_FILE`` themselves, which simply overrides this default.
    """
    monkeypatch.setattr(mh, "HEARTBEAT_FILE", tmp_path / "host_heartbeat.log")
