"""
file_upload transcript:
init → [HTTP upload → file_ref] → chat::message with payload.meta.attachments → chat::answer
"""
from __future__ import annotations

import pytest
import websockets

from .helpers import make_client, wait_for
from .mock_server import FIXED_ATTACHMENT_ID, FIXED_SESSION_ID, MockServer, start_mock_server


@pytest.mark.asyncio
async def test_file_upload() -> None:
    async def on_ws_message(
        msg: dict,
        ws: websockets.WebSocketServerProtocol,
        srv: MockServer,
    ) -> None:
        if msg.get("type") == "chat::message":
            await srv.send_to(ws, {
                "type": "chat::answer",
                "schema": "1.0",
                "session_id": FIXED_SESSION_ID,
                "seq": 1,
                "payload": {
                    "content": "The document covers three main topics.",
                    "role": "assistant",
                    "answer_kind": "final",
                    "turn_id": "turn_006",
                },
                "ts": "2026-04-04T00:00:00Z",
            })

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

        # Upload a file (bytes)
        file_ref = await client.upload_file(b"\x00\x01\x02\x03")
        assert file_ref == FIXED_ATTACHMENT_ID

        attachment_id = await client.upload_attachment(b"\x00\x01\x02\x03")
        assert attachment_id == FIXED_ATTACHMENT_ID

        session_file_bytes = await client.download_file(attachment_id)
        assert session_file_bytes == b"mock file bytes"

        session_files = await client.list_files()
        assert session_files["total"] == 1
        assert session_files["files"][0]["file_ref"] == FIXED_ATTACHMENT_ID
        assert "file_id" not in session_files["files"][0]

        project_files = await client.list_files(scope="project", project_id=42)
        assert project_files["total"] == 1

        promoted = await client.promote_file(attachment_id, project_id=42)
        assert promoted["file_ref"] == FIXED_ATTACHMENT_ID
        assert "file_id" not in promoted

        minted_url = await client.mint_session_file_download_url(attachment_id)
        assert minted_url == f"{server.http_url}/download-token/mock"

        project_file_bytes = await client.download_file(
            attachment_id,
            scope="project",
            project_id=42,
        )
        assert project_file_bytes == b"project file bytes"

        # Send message with attachment reference
        await client.send_message(
            "Please summarize this document.",
            attachments=[attachment_id],
        )

        with pytest.raises(Exception) as exc_info:
            await client.send_message(
                "Do not leak internal identity.",
                attachments=[{"file_ref": attachment_id, "file_id": "fi_private"}],  # type: ignore[list-item]
            )
        assert getattr(exc_info.value, "code", None) == "transport_protocol_violation"

        await wait_for(
            lambda: any(
                m["type"] == "chat::answer" and m["payload"].get("answer_kind") == "final"
                for m in received
            ),
            timeout=3.0,
        )

        # Verify chat::message payload includes attachment
        chat_msg = next(m for m in server.received if m["type"] == "chat::message")
        payload = chat_msg["payload"]
        assert payload["meta"]["attachments"] == [{"file_ref": FIXED_ATTACHMENT_ID}]  # type: ignore[index]
        assert "attachments" not in payload
        assert payload["content"] == "Please summarize this document."  # type: ignore[index]

        answer = next(
            m for m in received
            if m["type"] == "chat::answer" and m["payload"].get("answer_kind") == "final"
        )
        assert answer["payload"]["turn_id"] == "turn_006"
    finally:
        await client.disconnect()
        await server.close()
