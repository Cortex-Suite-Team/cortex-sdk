"""
reconnect_resync transcript:
init → message → [channel drop] → system::resync (with last_seq) → chat::answer replay
"""
from __future__ import annotations

import pytest
import websockets

from .helpers import make_client, wait_for
from .mock_server import FIXED_SESSION_ID, MockServer, start_mock_server


@pytest.mark.asyncio
async def test_reconnect_resync() -> None:
    resynced = False

    async def on_ws_message(
        msg: dict,
        ws: websockets.WebSocketServerProtocol,
        srv: MockServer,
    ) -> None:
        nonlocal resynced
        if msg.get("type") == "system::resync":
            resynced = True
            payload = msg.get("payload", {})
            assert isinstance(payload, dict)
            # Must include last_seq as an integer
            assert isinstance(payload.get("last_seq"), int)

            await srv.send_to(ws, {
                "type": "chat::answer",
                "schema": "1.0",
                "session_id": FIXED_SESSION_ID,
                "seq": 1,
                "payload": {
                    "content": ["Long task completed"],
                    "role": "assistant",
                    "answer_kind": "final",
                    "turn": 3,
                },
                "ts": "2026-04-04T00:00:00Z",
            })

    server = await start_mock_server(
        auto_chat_answer=False,
        auto_init_echo=True,
        on_ws_message=on_ws_message,
    )

    received = []
    client = make_client(server, received, ping_interval=60.0, stale_threshold=60.0)

    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)

        await client.send_message("Start a long task")

        # Drop all WS connections
        await server.drop_connections()

        # Wait for resync + replayed answer
        await wait_for(lambda: resynced, timeout=5.0)
        await wait_for(
            lambda: any(
                m["type"] == "chat::answer" and m["payload"].get("answer_kind") == "final"
                for m in received
            ),
            timeout=5.0,
        )

        answer = next(
            m for m in received
            if m["type"] == "chat::answer" and m["payload"].get("answer_kind") == "final"
        )
        assert answer["payload"]["content"] == ["Long task completed"]
        assert answer["payload"]["turn"] == 3

        resync_msg = next(m for m in server.received if m["type"] == "system::resync")
        assert isinstance(resync_msg["payload"]["last_seq"], int)  # type: ignore[index]
    finally:
        await client.disconnect()
        await server.close()
