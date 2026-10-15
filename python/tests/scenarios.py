from __future__ import annotations

import asyncio
import base64
import json
import time
from typing import Literal, TypedDict

import websockets

from .helpers import make_client, wait_for
from .mock_server import (
    FIXED_ATTACHMENT_ID,
    FIXED_SESSION_ID,
    MockServer,
    start_mock_server,
)

ScenarioName = Literal[
    "normal_chat",
    "streaming_chat",
    "reconnect_resync",
    "auth_refresh",
    "file_upload",
    "liveness",
]


class ScenarioMessage(TypedDict, total=False):
    type: str
    seq: int


class ScenarioResult(TypedDict):
    scenario: str
    messages_received: list[ScenarioMessage]
    session_state_final: str
    channel_state_final: str
    errors_received: list[str]
    callback_call_count: int


class ScenarioExecution(TypedDict):
    result: ScenarioResult
    schema_violations: list[dict[str, object]]
    diagnostics: dict[str, int]


def _make_jwt(claims: dict[str, object]) -> str:
    header = base64.urlsafe_b64encode(
        json.dumps({"alg": "HS256", "typ": "JWT"}).encode()
    ).rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    return f"{header}.{payload}.fakesig"


def _snapshot_result(
    scenario: ScenarioName,
    client,
    received: list[dict[str, object]],
) -> ScenarioResult:
    return {
        "scenario": scenario,
        "messages_received": [
            {
                "type": str(message["type"]),
                **({"seq": int(message["seq"])} if isinstance(message.get("seq"), int) else {}),
            }
            for message in received
        ],
        "session_state_final": client.session_state,
        "channel_state_final": client.channel_state,
        "errors_received": [
            str(message["payload"]["code"])
            for message in received
            if message["type"] == "system::error" and isinstance(message["payload"], dict)
        ],
        "callback_call_count": len(received),
    }


def _finalize_execution(
    scenario: ScenarioName,
    client,
    server: MockServer,
    received: list[dict[str, object]],
) -> ScenarioExecution:
    return {
        "result": _snapshot_result(scenario, client, received),
        "schema_violations": list(server.schema_violations),
        "diagnostics": {
            "ws_connection_count": server.ws_connection_count,
            "refresh_call_count": server.refresh_call_count,
            "upload_call_count": server.upload_call_count,
            "received_message_count": server.received_message_count,
        },
    }


async def run_normal_chat_scenario(schema_validation: bool = False) -> ScenarioExecution:
    server = await start_mock_server(
        auto_chat_answer=True,
        auto_init_echo=True,
        enable_schema_validation=schema_validation,
    )
    received: list[dict[str, object]] = []
    client = make_client(server, received)

    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)
        await client.send_message("Hello runtime")
        await wait_for(
            lambda: any(
                msg["type"] == "chat::answer" and msg["payload"].get("answer_kind") == "final"
                for msg in received
            )
        )
        return _finalize_execution("normal_chat", client, server, received)
    finally:
        await client.disconnect()
        await server.close()


async def run_streaming_chat_scenario(schema_validation: bool = False) -> ScenarioExecution:
    stream_sent = False

    async def on_ws_message(
        msg: dict[str, object],
        ws: websockets.WebSocketServerProtocol,
        srv: MockServer,
    ) -> None:
        nonlocal stream_sent
        if msg.get("type") == "chat::message" and not stream_sent:
            stream_sent = True
            seq = [1]

            def env(type_: str, payload: dict[str, object]) -> dict[str, object]:
                envelope = {
                    "type": type_,
                    "schema": "1.0",
                    "session_id": FIXED_SESSION_ID,
                    "seq": seq[0],
                    "payload": payload,
                    "ts": "2026-04-04T00:00:00Z",
                }
                seq[0] += 1
                return envelope

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
        enable_schema_validation=schema_validation,
        on_ws_message=on_ws_message,
    )
    received: list[dict[str, object]] = []
    client = make_client(server, received)

    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)
        await client.send_message("Explain quantum entanglement briefly.")
        await wait_for(
            lambda: any(
                msg["type"] == "chat::answer" and msg["payload"].get("answer_kind") == "final"
                for msg in received
            ),
            timeout=3.0,
        )
        return _finalize_execution("streaming_chat", client, server, received)
    finally:
        await client.disconnect()
        await server.close()


async def run_reconnect_resync_scenario(schema_validation: bool = False) -> ScenarioExecution:
    resynced = False

    async def on_ws_message(
        msg: dict[str, object],
        ws: websockets.WebSocketServerProtocol,
        srv: MockServer,
    ) -> None:
        nonlocal resynced
        if msg.get("type") == "system::resync":
            resynced = True
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
        enable_schema_validation=schema_validation,
        on_ws_message=on_ws_message,
    )
    received: list[dict[str, object]] = []
    client = make_client(server, received, ping_interval=60.0, stale_threshold=60.0)

    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)
        await client.send_message("Start a long task")
        await server.drop_connections()
        await wait_for(lambda: resynced, timeout=5.0)
        await wait_for(
            lambda: any(
                msg["type"] == "chat::answer" and msg["payload"].get("answer_kind") == "final"
                for msg in received
            ),
            timeout=5.0,
        )
        return _finalize_execution("reconnect_resync", client, server, received)
    finally:
        await client.disconnect()
        await server.close()


async def run_auth_refresh_scenario(schema_validation: bool = False) -> ScenarioExecution:
    first_answer_sent = False
    second_answer_sent = False
    expiring_token = _make_jwt({"exp": int(time.time()) + 30})
    refreshed_token = _make_jwt({"exp": int(time.time()) + 3600})

    async def on_ws_message(
        msg: dict[str, object],
        ws: websockets.WebSocketServerProtocol,
        srv: MockServer,
    ) -> None:
        nonlocal first_answer_sent, second_answer_sent
        if msg.get("type") == "chat::message" and not first_answer_sent:
            first_answer_sent = True
            await srv.send_to(ws, {
                "type": "chat::answer",
                "schema": "1.0",
                "session_id": FIXED_SESSION_ID,
                "seq": 1,
                "payload": {
                    "content": ["Response to first message"],
                    "role": "assistant",
                    "answer_kind": "final",
                    "turn": 4,
                },
                "ts": "2026-04-04T00:00:00Z",
            })

            async def close_later() -> None:
                await asyncio.sleep(0.025)
                await ws.close(1011, "refresh")

            asyncio.create_task(close_later())
            return

        if msg.get("type") == "chat::message" and first_answer_sent and not second_answer_sent:
            second_answer_sent = True
            await srv.send_to(ws, {
                "type": "chat::answer",
                "schema": "1.0",
                "session_id": FIXED_SESSION_ID,
                "seq": 2,
                "payload": {
                    "content": ["Response to second message"],
                    "role": "assistant",
                    "answer_kind": "final",
                    "turn": 5,
                },
                "ts": "2026-04-04T00:00:00Z",
            })

    server = await start_mock_server(
        auto_chat_answer=False,
        auto_init_echo=True,
        enable_schema_validation=schema_validation,
        initial_access_token=expiring_token,
        refreshed_access_token=refreshed_token,
        on_ws_message=on_ws_message,
    )
    received: list[dict[str, object]] = []
    client = make_client(
        server,
        received,
        ping_interval=60.0,
        stale_threshold=60.0,
        resync_timeout=2.0,
    )

    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)
        await client.send_message("First message before refresh")
        await wait_for(
            lambda: any(
                msg["type"] == "chat::answer" and msg["payload"].get("turn") == 4
                for msg in received
            ),
            timeout=3.0,
        )
        await wait_for(lambda: server.refresh_call_count >= 1, timeout=5.0)
        await wait_for(lambda: server.ws_connection_count >= 2, timeout=5.0)
        await client.send_message("Second message after refresh")
        await wait_for(
            lambda: any(
                msg["type"] == "chat::answer" and msg["payload"].get("turn") == 5
                for msg in received
            ),
            timeout=3.0,
        )
        return _finalize_execution("auth_refresh", client, server, received)
    finally:
        await client.disconnect()
        await server.close()


async def run_file_upload_scenario(schema_validation: bool = False) -> ScenarioExecution:
    async def on_ws_message(
        msg: dict[str, object],
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
                    "content": ["The document covers three main topics."],
                    "role": "assistant",
                    "answer_kind": "final",
                    "turn": 6,
                },
                "ts": "2026-04-04T00:00:00Z",
            })

    server = await start_mock_server(
        auto_chat_answer=False,
        auto_init_echo=True,
        enable_schema_validation=schema_validation,
        on_ws_message=on_ws_message,
    )
    received: list[dict[str, object]] = []
    client = make_client(server, received)

    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)
        attachment_id = await client.upload_attachment(b"\x00\x01\x02\x03")
        if attachment_id != FIXED_ATTACHMENT_ID:
            raise AssertionError(f"unexpected attachment id {attachment_id}")
        await client.send_message(
            "Please summarize this document.",
            attachments=[attachment_id],
        )
        await wait_for(
            lambda: any(
                msg["type"] == "chat::answer" and msg["payload"].get("answer_kind") == "final"
                for msg in received
            ),
            timeout=3.0,
        )
        return _finalize_execution("file_upload", client, server, received)
    finally:
        await client.disconnect()
        await server.close()


async def run_liveness_scenario(schema_validation: bool = False) -> ScenarioExecution:
    ping_count = 0

    async def on_ws_message(msg: dict[str, object], ws, srv) -> None:
        nonlocal ping_count
        if msg.get("type") == "system::ping":
            ping_count += 1

    server = await start_mock_server(
        auto_pong=True,
        auto_init_echo=True,
        enable_schema_validation=schema_validation,
        on_ws_message=on_ws_message,
    )
    received: list[dict[str, object]] = []
    client = make_client(
        server,
        received,
        ping_interval=0.1,
        pong_timeout=0.5,
        stale_threshold=5.0,
    )

    try:
        await client.connect()
        await wait_for(lambda: client.session_id is not None)
        await wait_for(lambda: ping_count >= 2, timeout=3.0)
        await asyncio.sleep(0.05)
        return _finalize_execution("liveness", client, server, received)
    finally:
        await client.disconnect()
        await server.close()


async def run_scenario_by_name(
    scenario: ScenarioName,
    *,
    schema_validation: bool = False,
) -> ScenarioExecution:
    if scenario == "normal_chat":
        return await run_normal_chat_scenario(schema_validation=schema_validation)
    if scenario == "streaming_chat":
        return await run_streaming_chat_scenario(schema_validation=schema_validation)
    if scenario == "reconnect_resync":
        return await run_reconnect_resync_scenario(schema_validation=schema_validation)
    if scenario == "auth_refresh":
        return await run_auth_refresh_scenario(schema_validation=schema_validation)
    if scenario == "file_upload":
        return await run_file_upload_scenario(schema_validation=schema_validation)
    if scenario == "liveness":
        return await run_liveness_scenario(schema_validation=schema_validation)
    raise AssertionError(f"unknown scenario {scenario}")


SCENARIO_NAMES: list[ScenarioName] = [
    "normal_chat",
    "streaming_chat",
    "reconnect_resync",
    "auth_refresh",
    "file_upload",
    "liveness",
]
