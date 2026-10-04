"""
liveness transcript:
ping/pong cycle — two complete cycles, plus stale-detection when pong stops.
"""
from __future__ import annotations

import pytest

from .helpers import make_client, wait_for
from .mock_server import start_mock_server


@pytest.mark.asyncio
async def test_liveness_two_cycles() -> None:
    """SDK sends pings, server echoes pongs — two complete cycles."""
    ping_count = 0

    async def on_ws_message(msg: dict, ws, srv) -> None:
        nonlocal ping_count
        if msg.get("type") == "system::ping":
            ping_count += 1
            payload = msg.get("payload", {})
            assert isinstance(payload["heartbeat_id"], str)
            assert isinstance(payload["channel_id"], str)

    server = await start_mock_server(
        auto_pong=True,
        auto_init_echo=True,
        on_ws_message=on_ws_message,
    )

    received = []
    client = make_client(
        server,
        received,
        ping_interval=0.1,   # fast ping for test
        pong_timeout=0.5,
        stale_threshold=5.0,
    )

    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)

        # Wait for at least 2 ping/pong cycles
        await wait_for(lambda: ping_count >= 2, timeout=3.0)

        assert ping_count >= 2
        assert client.channel_state == "OPEN"

        # Each ping has a unique heartbeat_id
        pings = [m for m in server.received if m["type"] == "system::ping"]
        ids = [m["payload"]["heartbeat_id"] for m in pings]  # type: ignore[index]
        assert len(ids) == len(set(ids)), "heartbeat_id must be unique per ping"
    finally:
        await client.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_liveness_stale_on_missing_pong_reconnects_and_resyncs() -> None:
    """A locally closed stale socket reconnects and resyncs the session."""
    stale_triggered = False

    server = await start_mock_server(
        auto_pong=False,   # no pong
        auto_init_echo=True,
    )

    received = []
    client = make_client(
        server,
        received,
        ping_interval=0.1,
        pong_timeout=0.2,
        stale_threshold=0.3,
    )

    original = client._handle_stale  # type: ignore[attr-defined]

    def patched_stale() -> None:
        nonlocal stale_triggered
        stale_triggered = True
        original()

    client._handle_stale = patched_stale  # type: ignore[method-assign]

    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)

        await wait_for(lambda: stale_triggered, timeout=3.0)
        assert stale_triggered
        await wait_for(lambda: server.ws_connection_count >= 2, timeout=5.0)
        await wait_for(
            lambda: any(message["type"] == "system::resync" for message in server.received),
            timeout=5.0,
        )
        assert client.channel_state == "OPEN"
    finally:
        await client.disconnect()
        await server.close()
