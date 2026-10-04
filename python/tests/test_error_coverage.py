from __future__ import annotations

import asyncio
import base64
import json
import time

import pytest

from cortex_sdk.errors import lookup_error, make_error

from .helpers import make_client, wait_for
from .mock_server import start_mock_server


def _make_jwt(claims: dict[str, object]) -> str:
    header = base64.urlsafe_b64encode(
        json.dumps({"alg": "HS256", "typ": "JWT"}).encode()
    ).rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    return f"{header}.{payload}.fakesig"


def _received_codes(messages: list[dict[str, object]]) -> list[str]:
    return [
        str(message["payload"]["code"])
        for message in messages
        if message["type"] == "system::error" and isinstance(message["payload"], dict)
    ]


@pytest.mark.asyncio
async def test_auth_invalid() -> None:
    meta = lookup_error("auth_invalid")
    assert meta is not None and meta.retryable is False and meta.fatal is True

    server = await start_mock_server(auto_init_echo=True)
    server.inject_error("auth_invalid", phase="ws_connect")
    received: list[dict[str, object]] = []
    client = make_client(server, received)

    try:
        await client.connect()
        await wait_for(lambda: client.channel_state == "AUTH_FAILED", timeout=3.0)
        await asyncio.sleep(0.2)
        assert client.channel_state == "AUTH_FAILED"
        assert server.ws_connection_count == 1
        assert _received_codes(received) == []
    finally:
        await client.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_auth_expired() -> None:
    meta = lookup_error("auth_expired")
    assert meta is not None and meta.retryable is True and meta.fatal is False

    expiring_token = _make_jwt({"exp": int(time.time()) + 30})
    refreshed_token = _make_jwt({"exp": int(time.time()) + 3600})

    async def on_ws_message(msg, ws, srv) -> None:
        if msg.get("type") == "chat::message":
            await srv.send_to(ws, {
                "type": "chat::answer",
                "schema": "1.0",
                "session_id": "sess_abc123",
                "seq": 1,
                "payload": {
                    "content": "Recovered after refresh",
                    "role": "assistant",
                    "answer_kind": "final",
                    "turn_id": "turn_auth_expired",
                },
                "ts": "2026-04-04T00:00:00Z",
            })

    server = await start_mock_server(
        auto_init_echo=True,
        auto_chat_answer=True,
        initial_access_token=expiring_token,
        refreshed_access_token=refreshed_token,
        on_ws_message=on_ws_message,
    )
    server.inject_error(
        "auth_expired",
        on_message_type="chat::message",
        close_after_send=True,
        close_code=1011,
    )
    received: list[dict[str, object]] = []
    client = make_client(server, received, ping_interval=60.0, stale_threshold=60.0)

    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)
        await client.send_message("trigger auth_expired")
        await wait_for(lambda: "auth_expired" in _received_codes(received), timeout=3.0)
        await wait_for(lambda: server.refresh_call_count >= 1, timeout=5.0)
        await wait_for(lambda: server.ws_connection_count >= 2, timeout=5.0)
        await wait_for(lambda: client.channel_state == "OPEN", timeout=5.0)
        await client.send_message("after refresh")
        await wait_for(
            lambda: any(
                message["type"] == "chat::answer"
                and message["payload"].get("answer_kind") == "final"
                for message in received
            ),
            timeout=3.0,
        )
        assert "auth_expired" in _received_codes(received)
    finally:
        await client.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_auth_refresh_failed() -> None:
    meta = lookup_error("auth_refresh_failed")
    assert meta is not None and meta.retryable is False and meta.fatal is True

    expiring_token = _make_jwt({"exp": int(time.time()) + 30})
    server = await start_mock_server(auto_init_echo=True, initial_access_token=expiring_token)
    server.inject_error("auth_refresh_failed", phase="auth_refresh")
    received: list[dict[str, object]] = []
    client = make_client(server, received, ping_interval=60.0, stale_threshold=60.0)

    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)
        await server.drop_connections()
        await wait_for(lambda: client.channel_state == "AUTH_FAILED", timeout=5.0)
        assert server.refresh_call_count >= 1
        assert server.ws_connection_count == 1
        assert _received_codes(received) == []
    finally:
        await client.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_transport_connect_timeout() -> None:
    meta = lookup_error("transport_connect_timeout")
    assert meta is not None and meta.retryable is True and meta.fatal is False

    server = await start_mock_server()
    server.inject_error("transport_connect_timeout", phase="auth_token")
    client = make_client(server, [], connect_timeout=0.1)

    try:
        with pytest.raises(Exception) as exc_info:
            await client.connect()
        err = exc_info.value
        assert getattr(err, "code", None) == "transport_connect_timeout"
        assert getattr(err, "retryable", None) is True
        assert getattr(err, "fatal", None) is False
        assert server.ws_connection_count == 0
    finally:
        await client.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_transport_send_timeout() -> None:
    meta = lookup_error("transport_send_timeout")
    assert meta is not None and meta.retryable is True and meta.fatal is False

    server = await start_mock_server(auto_init_echo=True)
    received: list[dict[str, object]] = []
    client = make_client(server, received)

    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)
        original_send = client._transport.send_json  # type: ignore[attr-defined]

        async def failing_send(message: dict[str, object]) -> None:
            raise make_error("transport_send_timeout", "Injected send timeout")

        client._transport.send_json = failing_send  # type: ignore[method-assign]
        with pytest.raises(Exception) as exc_info:
            await client.send_message("timeout")
        err = exc_info.value
        assert getattr(err, "code", None) == "transport_send_timeout"
        assert getattr(err, "retryable", None) is True
        assert getattr(err, "fatal", None) is False
        client._transport.send_json = original_send  # type: ignore[method-assign]
    finally:
        await client.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_transport_protocol_violation() -> None:
    meta = lookup_error("transport_protocol_violation")
    assert meta is not None and meta.retryable is False and meta.fatal is True

    server = await start_mock_server(auto_init_echo=True)
    server.inject_error("transport_protocol_violation", on_message_type="chat::message")
    received: list[dict[str, object]] = []
    client = make_client(server, received)

    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)
        await client.send_message("bad protocol")
        await wait_for(lambda: "transport_protocol_violation" in _received_codes(received), timeout=3.0)
        await wait_for(lambda: client.channel_state == "AUTH_FAILED", timeout=3.0)
        assert server.ws_connection_count == 1
    finally:
        await client.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_unknown_session() -> None:
    meta = lookup_error("unknown_session")
    assert meta is not None and meta.retryable is False and meta.fatal is True

    server = await start_mock_server(auto_init_echo=True)
    server.inject_error("unknown_session", phase="resync", close_after_send=True, close_code=1011)
    received: list[dict[str, object]] = []
    client = make_client(server, received, ping_interval=60.0, stale_threshold=60.0)

    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)
        await server.drop_connections()
        await wait_for(lambda: "unknown_session" in _received_codes(received), timeout=5.0)
        await wait_for(lambda: client.channel_state == "AUTH_FAILED", timeout=5.0)
        assert server.ws_connection_count >= 2
    finally:
        await client.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_session_terminal() -> None:
    meta = lookup_error("session_terminal")
    assert meta is not None and meta.retryable is False and meta.fatal is True

    server = await start_mock_server(auto_init_echo=True)
    server.inject_error("session_terminal", on_message_type="chat::message")
    received: list[dict[str, object]] = []
    client = make_client(server, received)

    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)
        await client.send_message("terminal")
        await wait_for(lambda: "session_terminal" in _received_codes(received), timeout=3.0)
        await wait_for(lambda: client.session_state == "FAILED", timeout=3.0)
        assert client.channel_state == "AUTH_FAILED"
    finally:
        await client.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_resync_timeout() -> None:
    meta = lookup_error("resync_timeout")
    assert meta is not None and meta.retryable is True and meta.fatal is False

    server = await start_mock_server(auto_init_echo=True)
    client = make_client(
        server,
        [],
        ping_interval=60.0,
        stale_threshold=60.0,
        resync_timeout=0.1,
    )

    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)
        original_send_resync = client._session.send_resync  # type: ignore[attr-defined]

        async def slow_resync() -> None:
            await asyncio.sleep(0.3)

        client._session.send_resync = slow_resync  # type: ignore[method-assign]
        await server.drop_connections()
        await wait_for(lambda: server.ws_connection_count >= 3, timeout=5.0)
        client._session.send_resync = original_send_resync  # type: ignore[method-assign]
    finally:
        await client.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_replay_unavailable() -> None:
    meta = lookup_error("replay_unavailable")
    assert meta is not None and meta.retryable is True and meta.fatal is False

    server = await start_mock_server(auto_init_echo=True)
    server.inject_error("replay_unavailable", phase="resync", close_after_send=True, close_code=1011)
    received: list[dict[str, object]] = []
    client = make_client(server, received, ping_interval=60.0, stale_threshold=60.0)

    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)
        await server.drop_connections()
        await wait_for(lambda: "replay_unavailable" in _received_codes(received), timeout=5.0)
        await wait_for(lambda: server.ws_connection_count >= 3, timeout=5.0)
        await wait_for(lambda: client.channel_state == "OPEN", timeout=5.0)
    finally:
        await client.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_file_upload_failed() -> None:
    meta = lookup_error("file_upload_failed")
    assert meta is not None and meta.retryable is True and meta.fatal is False

    server = await start_mock_server(auto_init_echo=True)
    server.inject_error("file_upload_failed", on_message_type="file::upload.prepare")
    client = make_client(server, [])

    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)
        with pytest.raises(Exception) as exc_info:
            await client.upload_attachment(b"\x00\x01")
        err = exc_info.value
        assert getattr(err, "code", None) == "file_upload_failed"
        assert getattr(err, "retryable", None) is True
        assert getattr(err, "fatal", None) is False
        assert server.upload_call_count == 0
    finally:
        await client.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_file_too_large() -> None:
    meta = lookup_error("file_too_large")
    assert meta is not None and meta.retryable is False and meta.fatal is False

    server = await start_mock_server(auto_init_echo=True)
    server.inject_error("file_too_large", on_message_type="file::upload.prepare")
    client = make_client(server, [])

    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)
        with pytest.raises(Exception) as exc_info:
            await client.upload_attachment(b"\x00\x01")
        err = exc_info.value
        assert getattr(err, "code", None) == "file_too_large"
        assert getattr(err, "retryable", None) is False
        assert getattr(err, "fatal", None) is False
        assert server.upload_call_count == 0
    finally:
        await client.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_file_type_rejected() -> None:
    meta = lookup_error("file_type_rejected")
    assert meta is not None and meta.retryable is False and meta.fatal is False

    server = await start_mock_server(auto_init_echo=True)
    server.inject_error("file_type_rejected", on_message_type="file::upload.prepare")
    client = make_client(server, [])

    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)
        with pytest.raises(Exception) as exc_info:
            await client.upload_attachment(b"\x00\x01")
        err = exc_info.value
        assert getattr(err, "code", None) == "file_type_rejected"
        assert getattr(err, "retryable", None) is False
        assert getattr(err, "fatal", None) is False
        assert server.upload_call_count == 0
    finally:
        await client.disconnect()
        await server.close()
