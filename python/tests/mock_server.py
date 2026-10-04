"""
Mock HTTP + WebSocket server for Python SDK tests.
Simple, not production-grade.

HTTP (threading-based):  /auth/token, /auth/refresh, Control Plane project files
WS  (websockets-based):  /ws
"""
from __future__ import annotations

import asyncio
import json
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Callable, Coroutine, Set
from urllib.parse import urlparse

import websockets
import websockets.asyncio.server
import websockets.exceptions

from .schema_validation import SchemaViolation, validate_outbound_envelope

FIXED_SESSION_ID = "sess_abc123"
FIXED_ACCESS_TOKEN = "access_token_v1"
FIXED_REFRESH_TOKEN = "refresh_token_v1"
FIXED_ATTACHMENT_ID = "sf_test123"

_seq_lock = threading.Lock()
_seq = 0


def _next_seq() -> int:
    global _seq
    with _seq_lock:
        _seq += 1
        return _seq


def _reset_seq() -> None:
    global _seq
    with _seq_lock:
        _seq = 0


def _ts() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _make_envelope(
    type_: str,
    payload: dict[str, object],
    session_id: str = FIXED_SESSION_ID,
) -> dict[str, object]:
    return {
        "type": type_,
        "schema": "1.0",
        "session_id": session_id,
        "seq": _next_seq(),
        "payload": payload,
        "ts": _ts(),
    }


def _default_http_status(code: str) -> int:
    if code in ("auth_invalid", "auth_refresh_failed"):
        return 401
    return 400


def _make_system_error_payload(code: str) -> dict[str, object]:
    return {
        "code": code,
        "message": f"Injected {code}",
    }


@dataclass
class ErrorInjectionOptions:
    phase: str | None = None
    after_messages: int | None = None
    on_message_type: str | None = None
    close_after_send: bool = False
    close_code: int | None = None
    close_reason: str | None = None
    status: int | None = None


@dataclass
class _InjectedError:
    code: str
    options: ErrorInjectionOptions
    consumed: bool = False


# ── HTTP mock server (runs in a thread) ────────────────────────────────────

class _MockHTTPHandler(BaseHTTPRequestHandler):
    """Minimal HTTP handler for auth and upload endpoints."""

    ws_port: int = 0
    hang_port: int = 0
    state: dict[str, object]
    state_lock: threading.Lock

    def log_message(self, *args: Any) -> None:  # noqa: ANN401
        pass

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length > 0 else b""

    def _send_json(self, body: dict[str, object], status: int = 200) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_bytes(self, body: bytes, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _take_injection(self, predicate: Callable[[_InjectedError], bool]) -> _InjectedError | None:
        with self.__class__.state_lock:
            injections = self.__class__.state["injections"]
            assert isinstance(injections, list)
            for injection in injections:
                assert isinstance(injection, _InjectedError)
                if not injection.consumed and predicate(injection):
                    injection.consumed = True
                    return injection
        return None

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        self._read_body()

        if path == "/auth/token":
            injection = self._take_injection(lambda candidate: candidate.options.phase == "auth_token")
            if injection and injection.code != "transport_connect_timeout":
                status = injection.options.status or _default_http_status(injection.code)
                self._send_json({
                    "error": injection.code,
                    "message": f"Injected {injection.code}",
                }, status=status)
                return

            with self.__class__.state_lock:
                access_token = str(self.__class__.state["access_token"])
                refresh_token = str(self.__class__.state["refresh_token"])

            ws_url = (
                f"ws://127.0.0.1:{self.__class__.hang_port}/ws"
                if injection and injection.code == "transport_connect_timeout"
                else f"ws://127.0.0.1:{self.__class__.ws_port}/ws"
            )
            self._send_json({
                "ws_url": ws_url,
                "cp_api_url": f"http://127.0.0.1:{self.server.server_address[1]}",
                "access_token": access_token,
                "refresh_token": refresh_token,
                "runtime_bootstrap": {
                    "execution_mode": "production",
                    "bundle_url": "/api/runtime/releases/42/bundle/",
                    "checksum": "sha256:release_42",
                },
            })
            return

        if path == "/auth/refresh":
            with self.__class__.state_lock:
                self.__class__.state["refresh_call_count"] = int(self.__class__.state["refresh_call_count"]) + 1
                refreshed_access_token = str(self.__class__.state["refreshed_access_token"])

            injection = self._take_injection(lambda candidate: candidate.options.phase == "auth_refresh")
            if injection:
                status = injection.options.status or _default_http_status(injection.code)
                self._send_json({
                    "error": injection.code,
                    "message": f"Injected {injection.code}",
                }, status=status)
                return

            self._send_json({"access_token": refreshed_access_token})
            return

        if path.startswith("/api/workspace/projects/") and path.endswith("/promote/"):
            self._send_json({
                "file_ref": FIXED_ATTACHMENT_ID,
                "filename": "upload",
                "scope_type": "persistent",
                "scope_id": "42",
                "status": "ready",
            })
            return

        self.send_response(404)
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/workspace/projects/") and path.endswith("/files/"):
            self._send_json({
                "files": [{
                    "file_ref": FIXED_ATTACHMENT_ID,
                    "filename": "upload",
                    "scope_type": "persistent",
                    "scope_id": "42",
                    "status": "ready",
                }],
                "total": 1,
            })
            return

        if path.startswith("/api/workspace/projects/") and path.endswith("/download/"):
            self._send_bytes(b"project file bytes")
            return

        self.send_response(404)
        self.end_headers()


# ── MockServer ─────────────────────────────────────────────────────────────

@dataclass
class MockServerOptions:
    auto_pong: bool = True
    auto_chat_answer: bool = True
    auto_init_echo: bool = True
    enable_schema_validation: bool = False
    initial_access_token: str = FIXED_ACCESS_TOKEN
    refreshed_access_token: str = "access_token_v2"
    refresh_token: str = FIXED_REFRESH_TOKEN
    on_ws_message: Callable[
        [
            dict[str, object],
            "websockets.asyncio.server.ServerConnection",
            "MockServer",
        ],
        Coroutine[Any, Any, None],
    ] | None = None


class MockServer:
    def __init__(
        self,
        http_port: int,
        ws_port: int,
        hang_port: int,
        http_server: HTTPServer,
        ws_server: websockets.asyncio.server.Server,
        hang_server: asyncio.AbstractServer,
        http_thread: threading.Thread,
        state: dict[str, object],
        state_lock: threading.Lock,
        options: MockServerOptions,
    ) -> None:
        self._http_port = http_port
        self._ws_port = ws_port
        self._hang_port = hang_port
        self._http_server = http_server
        self._ws_server = ws_server
        self._hang_server = hang_server
        self._http_thread = http_thread
        self._state = state
        self._state_lock = state_lock
        self._options = options

        self.received: list[dict[str, object]] = []
        self.clients: Set[websockets.asyncio.server.ServerConnection] = set()
        self.schema_violations: list[SchemaViolation] = []
        self._hang_writers: set[asyncio.StreamWriter] = set()

    @property
    def http_port(self) -> int:
        return self._http_port

    @property
    def ws_port(self) -> int:
        return self._ws_port

    @property
    def ws_connection_count(self) -> int:
        with self._state_lock:
            return int(self._state["ws_connection_count"])

    @property
    def refresh_call_count(self) -> int:
        with self._state_lock:
            return int(self._state["refresh_call_count"])

    @property
    def upload_call_count(self) -> int:
        with self._state_lock:
            return int(self._state["upload_call_count"])

    @property
    def received_message_count(self) -> int:
        return len(self.received)

    @property
    def http_url(self) -> str:
        return f"http://127.0.0.1:{self._http_port}"

    @property
    def auth_token_url(self) -> str:
        return f"{self.http_url}/auth/token"

    @property
    def auth_refresh_url(self) -> str:
        return f"{self.http_url}/auth/refresh"

    @property
    def ws_url(self) -> str:
        return f"ws://127.0.0.1:{self._ws_port}/ws"

    def _take_injection(self, predicate: Callable[[_InjectedError], bool]) -> _InjectedError | None:
        with self._state_lock:
            injections = self._state["injections"]
            assert isinstance(injections, list)
            for injection in injections:
                assert isinstance(injection, _InjectedError)
                if not injection.consumed and predicate(injection):
                    injection.consumed = True
                    return injection
        return None

    def inject_error(self, code: str, **kwargs: object) -> None:
        options = ErrorInjectionOptions(**kwargs)
        with self._state_lock:
            injections = self._state["injections"]
            assert isinstance(injections, list)
            injections.append(_InjectedError(code=code, options=options))

    def set_auth_tokens(
        self,
        *,
        access_token: str | None = None,
        refreshed_access_token: str | None = None,
        refresh_token: str | None = None,
    ) -> None:
        with self._state_lock:
            if access_token is not None:
                self._state["access_token"] = access_token
            if refreshed_access_token is not None:
                self._state["refreshed_access_token"] = refreshed_access_token
            if refresh_token is not None:
                self._state["refresh_token"] = refresh_token

    async def drop_connections(self) -> None:
        for ws in list(self.clients):
            try:
                ws.transport.abort()  # type: ignore[union-attr]
            except Exception:
                try:
                    await ws.close(1001, "drop")
                except Exception:
                    pass

    async def broadcast(self, msg: dict[str, object]) -> None:
        data = json.dumps(msg)
        for ws in list(self.clients):
            try:
                await ws.send(data)
            except Exception:
                pass

    async def send_to(
        self,
        ws: websockets.asyncio.server.ServerConnection,
        msg: dict[str, object],
    ) -> None:
        try:
            await ws.send(json.dumps(msg))
        except Exception:
            pass

    async def close(self) -> None:
        for ws in list(self.clients):
            try:
                await ws.close(1000, "shutdown")
            except Exception:
                pass
        for writer in list(self._hang_writers):
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass
        self._hang_server.close()
        await self._hang_server.wait_closed()
        self._ws_server.close()
        await self._ws_server.wait_closed()
        self._http_server.shutdown()
        self._http_thread.join(timeout=2)


# ── factory ────────────────────────────────────────────────────────────────

async def start_mock_server(
    auto_pong: bool = True,
    auto_chat_answer: bool = True,
    auto_init_echo: bool = True,
    enable_schema_validation: bool = False,
    initial_access_token: str = FIXED_ACCESS_TOKEN,
    refreshed_access_token: str = "access_token_v2",
    refresh_token: str = FIXED_REFRESH_TOKEN,
    on_ws_message: Callable[
        [
            dict[str, object],
            websockets.asyncio.server.ServerConnection,
            MockServer,
        ],
        Coroutine[Any, Any, None],
    ] | None = None,
) -> MockServer:
    """Start the mock HTTP + WS server and return a MockServer handle."""
    _reset_seq()

    options = MockServerOptions(
        auto_pong=auto_pong,
        auto_chat_answer=auto_chat_answer,
        auto_init_echo=auto_init_echo,
        enable_schema_validation=enable_schema_validation,
        initial_access_token=initial_access_token,
        refreshed_access_token=refreshed_access_token,
        refresh_token=refresh_token,
        on_ws_message=on_ws_message,
    )

    state_lock = threading.Lock()
    state: dict[str, object] = {
        "access_token": initial_access_token,
        "refresh_token": refresh_token,
        "refreshed_access_token": refreshed_access_token,
        "refresh_call_count": 0,
        "upload_call_count": 0,
        "ws_connection_count": 0,
        "injections": [],
    }

    server_ref: list[MockServer] = []

    async def _hang_handler(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        srv = server_ref[0]
        srv._hang_writers.add(writer)
        try:
            await reader.read()
        except Exception:
            pass
        finally:
            srv._hang_writers.discard(writer)
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def _ws_handler(
        ws: websockets.asyncio.server.ServerConnection,
    ) -> None:
        req = ws.request
        offered = req.headers.get("Sec-WebSocket-Protocol", "") if req else ""
        protocols = [p.strip() for p in offered.split(",")]
        has_jwt = any(p.startswith("cortex-sdk.jwt.") for p in protocols)
        if not has_jwt:
            await ws.close(4001, "auth_invalid")
            return

        srv = server_ref[0]
        with state_lock:
            state["ws_connection_count"] = int(state["ws_connection_count"]) + 1

        connect_injection = srv._take_injection(lambda candidate: candidate.options.phase == "ws_connect")
        if connect_injection and connect_injection.code == "auth_invalid":
            srv.clients.add(ws)

            async def close_later() -> None:
                await asyncio.sleep(0.025)
                await ws.close(4001, "auth_invalid")

            asyncio.create_task(close_later())
            try:
                async for _ in ws:
                    pass
            except websockets.exceptions.ConnectionClosed:
                pass
            finally:
                srv.clients.discard(ws)
            return

        srv.clients.add(ws)
        try:
            async for raw in ws:
                if isinstance(raw, bytes):
                    continue
                data = raw
                msg: dict[str, object] = json.loads(data)
                srv.received.append(msg)
                msg_type = msg.get("type")

                if options.enable_schema_validation:
                    violations = validate_outbound_envelope(msg)
                    if violations:
                        srv.schema_violations.extend(violations)
                        for violation in violations:
                            print("[mock_server] schema violation", json.dumps(violation, indent=2))
                        await srv.send_to(ws, _make_envelope(
                            "system::error",
                            _make_system_error_payload("transport_protocol_violation"),
                        ))
                        continue

                injection = srv._take_injection(
                    lambda candidate: (
                        candidate.options.phase in (None, "resync")
                        and (
                            (
                                candidate.options.phase == "resync"
                                and msg_type == "system::resync"
                            )
                            or (
                                candidate.options.phase is None
                                and (candidate.options.on_message_type is None or candidate.options.on_message_type == msg_type)
                                and (
                                    candidate.options.after_messages is None
                                    or len(srv.received) - 1 >= candidate.options.after_messages
                                )
                            )
                        )
                    )
                )
                if injection is not None:
                    injected = _make_envelope("system::error", _make_system_error_payload(injection.code))
                    if msg_type and str(msg_type).startswith("file::"):
                        injected["meta"] = msg.get("meta", {})
                    await srv.send_to(ws, injected)
                    if injection.options.close_after_send:
                        await ws.close(
                            injection.options.close_code or 1011,
                            injection.options.close_reason or injection.code,
                        )
                        continue

                if msg_type == "system::init" and options.auto_init_echo:
                    await srv.send_to(ws, _make_envelope("chat::echo", {
                        "content": "",
                        "role": "user",
                        "turn_id": "turn_init",
                    }))

                if msg_type == "system::ping" and options.auto_pong:
                    payload = msg.get("payload", {})
                    assert isinstance(payload, dict)
                    await srv.send_to(ws, {
                        "type": "system::pong",
                        "schema": "1.0",
                        "session_id": FIXED_SESSION_ID,
                        "payload": {
                            "heartbeat_id": payload.get("heartbeat_id"),
                            "channel_id": payload.get("channel_id"),
                            "server_ts": _ts(),
                        },
                        "ts": _ts(),
                    })

                meta = msg.get("meta", {})
                assert isinstance(meta, dict)
                correlation = {"client_msg_id": meta.get("client_msg_id")}
                if msg_type == "file::upload.prepare":
                    await srv.send_to(ws, {
                        "type": "file::upload.ready", "schema": "1.0", "session_id": FIXED_SESSION_ID,
                        "payload": {"transfer_id": "ft_01010101010101010101010101010101", "chunk_bytes": 2, "max_bytes": 52428800},
                        "meta": correlation, "ts": _ts(),
                    })
                if msg_type == "file::upload.commit":
                    await srv.send_to(ws, {
                        "type": "file::upload.complete", "schema": "1.0", "session_id": FIXED_SESSION_ID,
                        "payload": {"transfer_id": "ft_01010101010101010101010101010101", "file_ref": FIXED_ATTACHMENT_ID},
                        "meta": correlation, "ts": _ts(),
                    })
                if msg_type == "file::download.prepare":
                    transfer_id = "ft_02020202020202020202020202020202"
                    content = b"mock file bytes"
                    await srv.send_to(ws, {
                        "type": "file::download.ready", "schema": "1.0", "session_id": FIXED_SESSION_ID,
                        "payload": {"transfer_id": transfer_id, "filename": "upload", "content_type": "application/octet-stream", "size": len(content), "chunk_bytes": 262144},
                        "meta": correlation, "ts": _ts(),
                    })
                    await asyncio.sleep(0)
                    await ws.send(b"CFT1" + bytes.fromhex(transfer_id[3:]) + (0).to_bytes(4, "big") + content)
                    await srv.send_to(ws, {"type": "file::download.complete", "schema": "1.0", "session_id": FIXED_SESSION_ID, "payload": {"transfer_id": transfer_id}, "ts": _ts()})
                if msg_type == "file::list":
                    await srv.send_to(ws, {
                        "type": "file::list.result", "schema": "1.0", "session_id": FIXED_SESSION_ID,
                        "payload": {"files": [{"file_ref": FIXED_ATTACHMENT_ID, "filename": "upload", "scope_type": "session", "scope_id": FIXED_SESSION_ID, "status": "ready"}], "total": 1},
                        "meta": correlation, "ts": _ts(),
                    })

                if msg_type == "chat::message" and options.auto_chat_answer and injection is None:
                    await srv.send_to(ws, _make_envelope("chat::answer", {
                        "content": "Mock answer",
                        "role": "assistant",
                        "answer_kind": "final",
                        "turn_id": f"turn_{_next_seq()}",
                    }))

                if options.on_ws_message is not None:
                    await options.on_ws_message(msg, ws, srv)

        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            srv.clients.discard(ws)

    hang_server = await asyncio.start_server(_hang_handler, "127.0.0.1", 0)
    hang_port = hang_server.sockets[0].getsockname()[1]

    ws_server: websockets.asyncio.server.Server = await websockets.serve(
        _ws_handler,
        "127.0.0.1",
        0,
        subprotocols=["cortex-sdk.v1"],  # type: ignore[arg-type]
        ping_interval=None,
    )
    ws_port: int = ws_server.sockets[0].getsockname()[1]

    handler_cls = type(
        "_BoundHTTPHandler",
        (_MockHTTPHandler,),
        {
            "ws_port": ws_port,
            "hang_port": hang_port,
            "state": state,
            "state_lock": state_lock,
        },
    )
    http_server = HTTPServer(("127.0.0.1", 0), handler_cls)
    http_port: int = http_server.server_address[1]

    http_thread = threading.Thread(target=http_server.serve_forever, daemon=True)
    http_thread.start()

    server = MockServer(
        http_port=http_port,
        ws_port=ws_port,
        hang_port=hang_port,
        http_server=http_server,
        ws_server=ws_server,
        hang_server=hang_server,
        http_thread=http_thread,
        state=state,
        state_lock=state_lock,
        options=options,
    )
    server_ref.append(server)
    return server
