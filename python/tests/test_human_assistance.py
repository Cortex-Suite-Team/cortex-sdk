"""Human Assistance responder tests with a mock SessionManager WebSocket."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

from cortex_sdk import CortexError
from cortex_sdk.human_assistance import HumanAssistanceInbox
from cortex_sdk.types import HumanAssistanceNotification

from .helpers import make_client, wait_for
from .mock_server import start_mock_server


def envelope(type_: str, payload: dict[str, object], session_id: str = "sess_abc123") -> dict[str, object]:
    return {"type": type_, "schema": "1.0", "session_id": session_id,
            "payload": payload, "ts": datetime.now(timezone.utc).isoformat()}


def request(request_id: str, options: list[dict[str, str]] | None = None) -> dict[str, object]:
    return envelope("human_assistance::request", {
        "version": 1, "request_id": request_id, "question": "Choose and explain?",
        "options": [{"id": "approve", "label": "Approve"}] if options is None else options,
        "allow_text": True, "deadline_at": "2099-01-01T00:00:00Z", "status": "pending",
    })


def status(request_id: str, value: str, **extra: object) -> dict[str, object]:
    return envelope("human_assistance::status", {
        "version": 1, "request_id": request_id, "status": value, **extra,
    })


@pytest.mark.parametrize('invalid', [{'toString': None}, [], None])
def test_malformed_status_and_reason_leave_inbox_healthy(invalid: object) -> None:
    inbox = HumanAssistanceInbox()
    assert inbox.handle(request('req-malformed'), 'sess_abc123') is not None
    assert inbox.handle(envelope('human_assistance::status', {
        'version': 1, 'request_id': 'req-malformed', 'status': invalid,
    }), 'sess_abc123') is None
    assert inbox.handle(envelope('human_assistance::status', {
        'version': 1, 'request_id': 'req-malformed', 'status': 'reply_rejected',
        'client_reply_id': 'reply-malformed', 'reason': invalid,
    }), 'sess_abc123') is None
    assert [row['request_id'] for row in inbox.requests()] == ['req-malformed']
    assert inbox.handle(status('req-malformed', 'expired'), 'sess_abc123') is not None


@pytest.mark.parametrize('terminal', ['expired', 'revoked', 'resolved'])
def test_terminal_status_before_request_is_suppressed_in_inbox(terminal: str) -> None:
    inbox = HumanAssistanceInbox()
    assert inbox.handle(status(f'req-{terminal}', terminal), 'sess_abc123') is None
    assert inbox.handle(request(f'req-{terminal}'), 'sess_abc123') is None
    assert inbox.requests() == []
    with pytest.raises(CortexError):
        inbox.reply(request_id=f'req-{terminal}', client_reply_id='late', action='refuse',
                    option_id=None, text=None)


def test_terminal_cache_overflow_fails_closed() -> None:
    inbox = HumanAssistanceInbox()
    for index in range(65):
        assert inbox.handle(status(f'closed-{index}', 'resolved'), 'sess_abc123') is None
    assert inbox.handle(request('closed-0'), 'sess_abc123') is None
    assert inbox.handle(request('closed-64'), 'sess_abc123') is None
    assert inbox.handle(request('unknown-after-overflow'), 'sess_abc123') is None
    assert inbox.requests() == []


@pytest.mark.asyncio
async def test_terminal_status_before_request_over_mock_session_manager() -> None:
    server = await start_mock_server(auto_init_echo=True)
    events: list[HumanAssistanceNotification] = []
    client = make_client(server, [])
    client.on_human_assistance(events.append)
    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)
        a = client.session_id
        await server.broadcast(status('req-first-terminal', 'revoked'))
        await server.broadcast(request('req-first-terminal'))
        await asyncio.sleep(0.03)
        assert events == []
        assert client.human_assistance_requests == []
        assert client.session_id == a
    finally:
        await client.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_dw_a_stays_active_while_replying_to_two_dw_b_requests() -> None:
    server = await start_mock_server(auto_init_echo=True, enable_schema_validation=True)
    chat: list[dict[str, object]] = []
    events: list[HumanAssistanceNotification] = []
    client = make_client(server, chat)
    client.on_human_assistance(events.append)
    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)
        a = client.session_id
        await client.send_message("Message to A")
        await server.broadcast(envelope("chat::question", {"content": ["Question from A"]}))
        await wait_for(lambda: any(row["type"] == "chat::question" for row in chat))
        assert any(row["type"] == "chat::message" for row in server.received)
        chat_before = len(chat)
        await server.broadcast(request("req-b1"))
        await server.broadcast(request("req-b2", []))
        await wait_for(lambda: len(events) == 2)
        assert events[0]["type"] == "human_assistance::request"
        assert client.session_id == a and client.session_state == "ACTIVE"
        assert len(chat) == chat_before
        assert [row["request_id"] for row in client.human_assistance_requests] == ["req-b1", "req-b2"]

        await client.reply_human_assistance(request_id="req-b1", client_reply_id="reply-1",
                                            action="answer", option_id="approve", text="Enough evidence")
        await client.reply_human_assistance(request_id="req-b2", client_reply_id="reply-2",
                                            action="answer", text="Text only")
        await client.reply_human_assistance(request_id="req-b1", client_reply_id="reply-3",
                                            action="refuse")
        await wait_for(lambda: len([row for row in server.received if row["type"] == "human_assistance::reply"]) == 3)
        replies = [row for row in server.received if row["type"] == "human_assistance::reply"]
        assert [row["session_id"] for row in replies] == [a, a, a]
        assert [row["payload"] for row in replies] == [
            {"version": 1, "request_id": "req-b1", "client_reply_id": "reply-1", "action": "answer",
             "option_id": "approve", "text": "Enough evidence"},
            {"version": 1, "request_id": "req-b2", "client_reply_id": "reply-2", "action": "answer",
             "text": "Text only"},
            {"version": 1, "request_id": "req-b1", "client_reply_id": "reply-3", "action": "refuse"},
        ]
        assert all("wait_token" not in str(row) for row in replies)
        assert not server.schema_violations
        assert len(chat) == chat_before and client.session_id == a
    finally:
        await client.disconnect()
        await server.close()


@pytest.mark.asyncio
async def test_replay_denials_invalid_and_late_reply_do_not_enter_chat() -> None:
    server = await start_mock_server(auto_init_echo=True)
    chat: list[dict[str, object]] = []
    events: list[HumanAssistanceNotification] = []
    client = make_client(server, chat)
    client.on_human_assistance(events.append)
    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)
        a = client.session_id
        await server.broadcast(request("req-b1"))
        await wait_for(lambda: len(events) == 1)
        await server.broadcast(request("req-b1"))
        changed = request("req-b1")
        changed["payload"]["question"] = "Changed?"  # type: ignore[index]
        await server.broadcast(changed)
        await server.broadcast(request("req-fake") | {"session_id": "foreign"})
        forged = request("req-invalid")
        forged["payload"]["wait_token"] = "forged"  # type: ignore[index]
        await server.broadcast(forged)
        await asyncio.sleep(0.03)
        assert len(events) == 1
        with pytest.raises(CortexError):
            await client.reply_human_assistance(request_id="req-fake", client_reply_id="fake",
                                                action="answer", text="x")
        with pytest.raises(CortexError):
            await client.reply_human_assistance(request_id="req-b1", client_reply_id="bad", action="answer")
        with pytest.raises(CortexError):
            await client.reply_human_assistance(request_id="req-b1", client_reply_id="bad2",
                                                action="answer", option_id="unknown")
        await client.reply_human_assistance(request_id="req-b1", client_reply_id="stable",
                                            action="answer", option_id="approve")
        await client.reply_human_assistance(request_id="req-b1", client_reply_id="stable",
                                            action="answer", option_id="approve")
        with pytest.raises(CortexError):
            await client.reply_human_assistance(request_id="req-b1", client_reply_id="stable", action="refuse")
        await server.drop_connections()
        await wait_for(lambda: server.ws_connection_count >= 2 and client.channel_state == "OPEN")
        await server.broadcast(request("req-b1"))
        await asyncio.sleep(0.03)
        assert len(events) == 1
        await server.broadcast(status("req-b1", "reply_rejected", client_reply_id="stable", reason="unauthorized"))
        await wait_for(lambda: len(events) == 2)
        await server.broadcast(status("req-b1", "reply_rejected", client_reply_id="stable", reason="unauthorized"))
        await server.broadcast(status("req-b1", "reply_rejected", client_reply_id="stable", reason="duplicate"))
        await wait_for(lambda: len(events) == 3)
        await server.broadcast(status("req-b1", "reply_rejected", client_reply_id="stable", reason="unauthorized"))
        await asyncio.sleep(0.03)
        assert len(events) == 3
        await server.broadcast(status("req-b1", "expired"))
        await wait_for(lambda: len(events) == 4)
        assert events[1] == {"type": "human_assistance::status", "payload": {
            "version": 1, "request_id": "req-b1", "status": "reply_rejected",
            "client_reply_id": "stable", "reason": "unauthorized",
        }}
        assert client.human_assistance_requests == []
        with pytest.raises(CortexError):
            await client.reply_human_assistance(request_id="req-b1", client_reply_id="late", action="refuse")
        assert client.session_id == a
        assert not [row for row in chat if row["type"] in ("human_assistance::request", "human_assistance::status")]
    finally:
        await client.disconnect()
        await server.close()
