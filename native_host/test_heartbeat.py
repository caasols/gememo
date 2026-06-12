#!/usr/bin/env python3
"""Tests for the BUG-9 Layer 0 stage heartbeat in meeting_minutes_host.py."""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import meeting_minutes_host as mh


def test_heartbeat_appends_fsync_line(tmp_path, monkeypatch):
    hb = tmp_path / "host_heartbeat.log"
    monkeypatch.setattr(mh, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(mh, "HEARTBEAT_FILE", hb)
    mh._heartbeat("start type=capture chars=10")
    mh._heartbeat("parsed")
    lines = hb.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 2
    assert "start type=capture chars=10" in lines[0]
    assert lines[1].endswith("parsed")
    assert f"pid={os.getpid()}" in lines[0]


def test_heartbeat_never_raises_on_bad_dir(monkeypatch):
    bad = Path("/nonexistent-root-xyz-12345/mm2c")
    monkeypatch.setattr(mh, "CACHE_DIR", bad)
    monkeypatch.setattr(mh, "HEARTBEAT_FILE", bad / "host_heartbeat.log")
    mh._heartbeat("start")  # must not raise


def test_rotate_trims_when_over_cap(tmp_path, monkeypatch):
    hb = tmp_path / "host_heartbeat.log"
    monkeypatch.setattr(mh, "HEARTBEAT_FILE", hb)
    monkeypatch.setattr(mh, "_HEARTBEAT_MAX_BYTES", 200)
    hb.write_text("\n".join(f"line{i}" for i in range(100)) + "\n", encoding="utf-8")
    mh._heartbeat_rotate()
    assert hb.stat().st_size <= 200
    assert "line99" in hb.read_text(encoding="utf-8")  # tail retained


def test_rotate_noop_when_small(tmp_path, monkeypatch):
    hb = tmp_path / "host_heartbeat.log"
    monkeypatch.setattr(mh, "HEARTBEAT_FILE", hb)
    hb.write_text("small\n", encoding="utf-8")
    mh._heartbeat_rotate()
    assert hb.read_text(encoding="utf-8") == "small\n"
