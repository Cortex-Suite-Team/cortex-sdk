"""
streaming_chat transcript:
system::init → chat::message → chat::partial ×2 → chat::answer
"""
from __future__ import annotations

import pytest
import websockets

from .helpers import make_client, wait_for
from .mock_server import FIXED_SESSION_ID, MockServer, start_mock_server


@pytest.mark.asyncio
async def test_streaming_chat() -> None:
    stream_sent = False

    async def on_ws_message(
        msg: dict,
        ws: websockets.WebSocketServerProtocol,
        srv: MockServer,
    ) -> None:
        nonlocal stream_sent
        if msg.get("type") == "chat::message" and not stream_sent:
            stream_sent = True
            seq = [1]

            def env(type_: str, payload: dict) -> dict:
                e = {
                    "type": type_,
                    "schema": "1.0",
                    "session_id": FIXED_SESSION_ID,
                    "seq": seq[0],
                    "payload": payload,
                    "ts": "2026-04-04T00:00:00Z",
                }
                seq[0] += 1
                return e

            await srv.send_to(ws, env("chat::partial", {
                "content": ["Quantum entanglement is "],
                "role": "assistant",
                "turn": 2,
            }))
            await srv.send_to(ws, env("chat::partial", {
                "content": ["a phenomenon where two particles "],
                "role": "assistant",
                "turn": 2,
            }))
            await srv.send_to(ws, env("chat::answer", {
                "content": ["Quantum entanglement is a phenomenon where two particles remain correlated regardless of distance."],
                "role": "assistant",
                "answer_kind": "final",
                "turn": 2,
            }))

    server = await start_mock_server(
        auto_chat_answer=False,
        auto_init_echo=True,
        on_ws_message=on_ws_message,
    )

    received = []
    client = make_client(server, received)

    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)

        await client.send_message("Explain quantum entanglement briefly.")

        await wait_for(
            lambda: any(
                m["type"] == "chat::answer" and m["payload"].get("answer_kind") == "final"
                for m in received
            ),
            timeout=3.0,
        )

        partials = [m for m in received if m["type"] == "chat::partial"]
        answer = next(
            m for m in received
            if m["type"] == "chat::answer" and m["payload"].get("answer_kind") == "final"
        )

        assert len(partials) == 2
        assert partials[0]["payload"]["content"] == ["Quantum entanglement is "]
        assert partials[1]["payload"]["content"] == ["a phenomenon where two particles "]
        # Runtime correlates partials with their final answer by the integer turn only.
        assert answer["payload"]["turn"] == 2
        for partial in partials:
            assert partial["payload"]["turn"] == answer["payload"]["turn"]
            assert "turn_id" not in partial["payload"]
        streamed = "".join(block for p in partials for block in p["payload"]["content"])
        assert "".join(answer["payload"]["content"]).startswith(streamed)
        assert answer["payload"]["answer_kind"] == "final"
        # callback was invoked for each message
        assert len([m for m in received if m["type"] in ("chat::partial", "chat::answer")]) >= 3
    finally:
        await client.disconnect()
        await server.close()
