from __future__ import annotations

import json

import pytest

from cortex_sdk.session import SessionManager


class DummyTransport:
    async def send_json(self, envelope: dict[str, object]) -> None:
        return None


BOOTSTRAP = {
    "execution_mode": "production",
    "bundle_url": "/api/runtime/releases/42/bundle/",
    "checksum": "sha256:test",
}


def make_server_message(type_: str, payload: dict[str, object]) -> str:
    return json.dumps({
        "type": type_,
        "schema": "1.0",
        "session_id": "sess_123",
        "payload": payload,
        "ts": "2026-04-04T00:00:00Z",
    })


@pytest.mark.asyncio
async def test_session_moves_to_active_when_runtime_assigns_session_id() -> None:
    session = SessionManager(on_message=lambda msg: None, on_fatal_error=lambda err: None)
    session.set_transport(DummyTransport(), 10.0)

    await session.send_init(BOOTSTRAP)
    assert session.session_state == "INITIALIZING"

    session.handle_incoming(make_server_message("chat::echo", {
        "content": "init ack",
        "role": "user",
    }))

    assert session.session_id == "sess_123"
    assert session.session_state == "ACTIVE"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("type_", "payload", "expected_state"),
    [
        ("sandbox::snapshot", {"state": "waiting"}, "WAITING"),
        ("sandbox::lifecycle", {"status": "active"}, "ACTIVE"),
        ("sandbox::lifecycle", {"status": "completed"}, "COMPLETED"),
        ("sandbox::lifecycle", {"status": "failed"}, "FAILED"),
        ("sandbox::lifecycle", {"status": "stopped"}, "STOPPED"),
        ("sandbox::lifecycle", {"status": "timeout"}, "TIMEOUT"),
        ("sandbox::lifecycle", {"status": "cancelled"}, "CANCELLED"),
    ],
)
async def test_session_maps_runtime_lifecycle_states(
    type_: str,
    payload: dict[str, object],
    expected_state: str,
) -> None:
    session = SessionManager(on_message=lambda msg: None, on_fatal_error=lambda err: None)
    session.set_transport(DummyTransport(), 10.0)

    await session.send_init(BOOTSTRAP)
    session.handle_incoming(make_server_message(type_, payload))

    assert session.session_state == expected_state


@pytest.mark.asyncio
async def test_terminal_system_error_marks_session_failed() -> None:
    fatal_errors = []
    session = SessionManager(
        on_message=lambda msg: None,
        on_fatal_error=lambda err: fatal_errors.append(err),
    )
    session.set_transport(DummyTransport(), 10.0)

    await session.send_init(BOOTSTRAP)
    session.handle_incoming(make_server_message("system::error", {
        "code": "session_terminal",
        "message": "Session ended",
    }))

    assert session.session_state == "FAILED"
    assert len(fatal_errors) == 1
