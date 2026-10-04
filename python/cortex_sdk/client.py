from __future__ import annotations

import asyncio
import secrets
from typing import BinaryIO
from urllib.parse import quote, urlencode, urlsplit, urlunsplit

import httpx

from .auth import (
    exchange_api_key,
    refresh_access_token,
    is_token_expiring_soon,
    normalize_auth_base_url,
)
from .constants import (
    DEFAULT_AUTH_URL,
    DEFAULT_CONNECT_TIMEOUT,
    DEFAULT_SEND_TIMEOUT,
    DEFAULT_RESYNC_TIMEOUT,
    DEFAULT_PING_INTERVAL,
    DEFAULT_PONG_TIMEOUT,
    DEFAULT_STALE_THRESHOLD,
    TOKEN_REFRESH_BUFFER,
    RECONNECT_BACKOFF,
)
from .errors import CortexError, make_error
from .files import parse_public_file_list, parse_public_file_ref, require_session_file_ref
from .liveness import LivenessMonitor
from .session import SessionManager
from .transport import Transport
from .types import (
    ChannelState,
    CortexMessage,
    EscalationReplyAction,
    EscalationReplyContent,
    FileListResult,
    FileRef,
    FileScope,
    MessageCallback,
    SessionFileAttachmentInput,
    SessionState,
)
from .upload import upload_file


class CortexClient:
    """Cortex SDK client — one instance per session.

    Public API:
        connect() / disconnect()
        send_message(content, attachments)
        upload_attachment(file)
        stop()
        session_state / channel_state / session_id  (read-only properties)

    Time options are in **seconds** (not milliseconds).
    """

    def __init__(
        self,
        api_key: str,
        on_message: MessageCallback,
        worker_ref: str | None = None,
        auth_url: str | None = None,
        connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
        send_timeout: float = DEFAULT_SEND_TIMEOUT,
        resync_timeout: float = DEFAULT_RESYNC_TIMEOUT,
        ping_interval: float = DEFAULT_PING_INTERVAL,
        pong_timeout: float = DEFAULT_PONG_TIMEOUT,
        stale_threshold: float = DEFAULT_STALE_THRESHOLD,
        # Private test override — not part of the public API
        _upload_url: str | None = None,
    ) -> None:
        self._api_key = api_key
        self._worker_ref = worker_ref
        self._on_message_cb = on_message
        self._auth_url = normalize_auth_base_url(auth_url or DEFAULT_AUTH_URL)
        self._connect_timeout = connect_timeout
        self._send_timeout = send_timeout
        self._resync_timeout = resync_timeout
        self._ping_interval = ping_interval
        self._pong_timeout = pong_timeout
        self._stale_threshold = stale_threshold

        self._upload_url = _upload_url  # None → runtime-side upload URL heuristic

        # Internal state
        self._channel_state: ChannelState = "CLOSED"
        self._access_token: str | None = None
        self._refresh_token: str | None = None
        self._ws_url: str | None = None
        self._runtime_http_base_url: str | None = None
        self._cp_api_url: str | None = None
        self._channel_id: str = f"ch_{secrets.token_hex(4)}"
        self._reconnect_attempt: int = 0
        self._disconnect_requested: bool = False

        # Components
        self._transport = Transport(connect_timeout, send_timeout)
        self._session = SessionManager(
            on_message=self._dispatch_message,
            on_fatal_error=self._handle_fatal_error,
        )
        self._liveness: LivenessMonitor | None = None
        self._reconnect_task: asyncio.Task[None] | None = None
        self._token_refresh_task: asyncio.Task[None] | None = None

        # Wire transport callbacks
        self._transport.on_message = self._session.handle_incoming
        self._transport.on_close = self._handle_close
        self._transport.on_error = None  # handled via on_close

    # ── public properties ─────────────────────────────────────────────────────

    @property
    def session_state(self) -> SessionState:
        return self._session.session_state

    @property
    def channel_state(self) -> ChannelState:
        return self._channel_state

    @property
    def session_id(self) -> str | None:
        return self._session.session_id

    # ── public methods ────────────────────────────────────────────────────────

    async def connect(self) -> None:
        """Full bootstrap: auth exchange → WS open → system::init → liveness start."""
        self._disconnect_requested = False
        self._reconnect_attempt = 0

        auth = await exchange_api_key(
            self._api_key,
            auth_base_url=self._auth_url,
            worker_ref=self._worker_ref,
        )
        self._access_token = auth["access_token"]
        self._refresh_token = auth["refresh_token"]
        self._ws_url = auth["ws_url"]
        self._runtime_http_base_url = _derive_runtime_http_base_url_from_ws_url(self._ws_url)
        self._cp_api_url = _normalize_optional_base_url(auth.get("cp_api_url"))
        if self._upload_url is None:
            self._upload_url = _derive_upload_url_from_ws_url(self._ws_url)
        else:
            self._runtime_http_base_url = (
                _derive_runtime_http_base_url_from_http_url(self._upload_url)
                or self._runtime_http_base_url
            )

        await self._open_channel()

        self._session.set_transport(self._transport, self._send_timeout)
        await self._session.send_init(auth["runtime_bootstrap"])

        self._start_liveness()
        self._schedule_token_refresh()

    async def disconnect(self) -> None:
        """Close the session and WebSocket connection cleanly."""
        self._disconnect_requested = True
        self._stop_liveness()
        self._stop_token_refresh()

        if self._reconnect_task and not self._reconnect_task.done():
            self._reconnect_task.cancel()
            try:
                await self._reconnect_task
            except (asyncio.CancelledError, Exception):
                pass
            self._reconnect_task = None

        self._channel_state = "CLOSED"
        await self._transport.aclose()

    async def send_message(
        self, content: str, attachments: list[SessionFileAttachmentInput] | None = None
    ) -> None:
        await self._wait_for_open_channel()
        await self._session.send_chat_message(content, attachments)

    async def reply_escalation(
        self,
        *,
        escalation_id: str,
        wait_token: str,
        action: EscalationReplyAction,
        content: EscalationReplyContent | None = None,
        meta: dict[str, object] | None = None,
    ) -> None:
        await self._wait_for_open_channel()
        self._require_session_id()
        await self._session.send_escalation_reply(
            escalation_id=escalation_id,
            wait_token=wait_token,
            action=action,
            content=content,
            meta=meta,
        )

    async def upload_file(
        self,
        file: str | bytes | BinaryIO,
        *,
        session_id: str | None = None,
    ) -> str:
        if not self._access_token:
            raise make_error("auth_invalid", "Not connected")
        effective_session_id = self._require_session_id(session_id)
        url = self._upload_url or "/upload"
        url = _with_query_params(url, {"session_id": effective_session_id})
        return await upload_file(file, self._access_token, upload_url=url)

    async def upload_attachment(self, file: str | bytes | BinaryIO) -> str:
        return await self.upload_file(file)

    async def mint_session_file_download_url(
        self,
        file_ref: str,
        *,
        session_id: str | None = None,
    ) -> str:
        if not self._access_token:
            raise make_error("auth_invalid", "Not connected")
        canonical_file_ref = require_session_file_ref(file_ref)
        effective_session_id = self._require_session_id(session_id)
        base_url = self._require_runtime_http_base_url()
        url = (
            f"{base_url}/sessions/{quote(effective_session_id, safe='')}"
            f"/files/{quote(canonical_file_ref, safe='')}/download-token"
        )
        body = await self._request_json(url, method="POST")
        download_url = body.get("download_url")
        if not isinstance(download_url, str) or not download_url:
            raise make_error("file_operation_failed", "Download token response missing download_url")
        return download_url if download_url.startswith("http") else f"{base_url}{download_url}"

    async def download_file(
        self,
        file_ref: str,
        *,
        scope: FileScope = "session",
        session_id: str | None = None,
        project_id: str | int | None = None,
    ) -> bytes:
        if not self._access_token:
            raise make_error("auth_invalid", "Not connected")
        canonical_file_ref = require_session_file_ref(file_ref)

        if scope == "session":
            effective_session_id = self._require_session_id(session_id)
            base_url = self._require_runtime_http_base_url()
            url = f"{base_url}/download/{quote(canonical_file_ref, safe='')}"
            url = _with_query_params(url, {"session_id": effective_session_id})
        elif scope == "project":
            if project_id is None:
                raise make_error("file_operation_failed", "project_id is required for project file download")
            base_url = self._require_cp_api_url()
            url = (
                f"{base_url}/api/workspace/projects/{quote(str(project_id), safe='')}"
                f"/files/{quote(canonical_file_ref, safe='')}/download/"
            )
        else:
            raise make_error("file_operation_failed", f"Unsupported file scope: {scope}")

        return await self._request_bytes(url)

    async def list_files(
        self,
        *,
        scope: FileScope = "session",
        session_id: str | None = None,
        project_id: str | int | None = None,
        limit: int = 50,
        offset: int = 0,
        include_trashed: bool = False,
    ) -> FileListResult:
        if not self._access_token:
            raise make_error("auth_invalid", "Not connected")

        query = {
            "limit": limit,
            "offset": offset,
            "include_trashed": str(include_trashed).lower(),
        }
        if scope == "session":
            effective_session_id = self._require_session_id(session_id)
            base_url = self._require_runtime_http_base_url()
            url = f"{base_url}/sessions/{quote(effective_session_id, safe='')}/files/"
        elif scope == "project":
            if project_id is None:
                raise make_error("file_operation_failed", "project_id is required for project file list")
            base_url = self._require_cp_api_url()
            url = f"{base_url}/api/workspace/projects/{quote(str(project_id), safe='')}/files/"
        else:
            raise make_error("file_operation_failed", f"Unsupported file scope: {scope}")

        body = await self._request_json(_with_query_params(url, query))
        return parse_public_file_list(body)

    async def promote_file(self, file_ref: str, *, project_id: str | int) -> FileRef:
        if not self._access_token:
            raise make_error("auth_invalid", "Not connected")
        canonical_file_ref = require_session_file_ref(file_ref)
        base_url = self._require_cp_api_url()
        url = (
            f"{base_url}/api/workspace/projects/{quote(str(project_id), safe='')}"
            f"/files/{quote(canonical_file_ref, safe='')}/promote/"
        )
        body = await self._request_json(url, method="POST")
        return parse_public_file_ref(body)

    async def stop(self) -> None:
        await self._wait_for_open_channel()
        await self._session.send_stop()

    # ── internal helpers ──────────────────────────────────────────────────────

    async def _open_channel(self) -> None:
        if not self._ws_url or not self._access_token:
            raise RuntimeError("Auth not completed before _open_channel")
        self._channel_state = "CONNECTING"
        await self._transport.open(self._ws_url, self._access_token)
        self._channel_state = "OPEN"
        self._reconnect_attempt = 0

    def _start_liveness(self) -> None:
        self._stop_liveness()
        self._liveness = LivenessMonitor(
            transport=self._transport,
            ping_interval=self._ping_interval,
            pong_timeout=self._pong_timeout,
            stale_threshold=self._stale_threshold,
            on_stale=self._handle_stale,
            get_session_id=lambda: self._session.session_id,
            get_channel_id=lambda: self._channel_id,
        )
        self._liveness.start()

    async def _wait_for_open_channel(self) -> None:
        if self._channel_state == "OPEN":
            return
        if self._channel_state == "AUTH_FAILED":
            raise make_error("auth_invalid", "Authentication failed")
        if self._channel_state == "CLOSED":
            raise make_error("transport_send_timeout", "No open connection")

        deadline = self._send_timeout + self._resync_timeout
        try:
            await asyncio.wait_for(self._wait_until_open_or_terminal(), timeout=deadline)
        except asyncio.TimeoutError as exc:
            raise make_error("transport_send_timeout", "Channel is not open") from exc

        if self._channel_state == "AUTH_FAILED":
            raise make_error("auth_invalid", "Authentication failed")
        if self._channel_state != "OPEN":
            raise make_error("transport_send_timeout", "Channel is not open")

    async def _wait_until_open_or_terminal(self) -> None:
        while self._channel_state not in {"OPEN", "AUTH_FAILED", "CLOSED"}:
            await asyncio.sleep(0.01)

    def _stop_liveness(self) -> None:
        if self._liveness:
            self._liveness.stop()
            self._liveness = None

    def _schedule_token_refresh(self) -> None:
        self._stop_token_refresh()

        async def _refresh_loop() -> None:
            try:
                while not self._disconnect_requested:
                    await asyncio.sleep(TOKEN_REFRESH_BUFFER / 2)
                    if not self._access_token or not self._refresh_token:
                        continue
                    if is_token_expiring_soon(self._access_token):
                        try:
                            self._access_token = await refresh_access_token(
                                self._refresh_token,
                                auth_base_url=self._auth_url,
                            )
                        except Exception:
                            pass  # surfaced at next reconnect
            except asyncio.CancelledError:
                pass

        self._token_refresh_task = asyncio.create_task(_refresh_loop())

    def _stop_token_refresh(self) -> None:
        if self._token_refresh_task and not self._token_refresh_task.done():
            self._token_refresh_task.cancel()
        self._token_refresh_task = None

    # ── callbacks from transport / session ────────────────────────────────────

    def _dispatch_message(self, msg: CortexMessage) -> None:
        # system::pong is internal — route to liveness, not to user callback
        if msg.get("type") == "system::pong":
            hb_id = msg["payload"].get("heartbeat_id")
            if isinstance(hb_id, str) and self._liveness:
                self._liveness.record_pong(hb_id)
            return
        self._on_message_cb(msg)

    def _handle_fatal_error(self, err: CortexError) -> None:
        self._channel_state = "AUTH_FAILED"
        self._stop_liveness()
        self._stop_token_refresh()
        self._transport.close()
        # Surface error as a system::error message
        error_msg: CortexMessage = {
            "type": "system::error",
            "schema": "1.0",
            "session_id": self._session.session_id or "",
            "payload": {"code": err.code, "message": str(err)},
            "ts": _now_iso(),
        }
        self._on_message_cb(error_msg)

    def _handle_stale(self) -> None:
        if self._channel_state in ("STALE", "RECONNECTING"):
            return
        self._channel_state = "STALE"
        self._stop_liveness()
        self._transport.close(1001, "stale")
        # on_close will trigger reconnect

    def _handle_close(self, code: int, reason: str) -> None:
        if self._disconnect_requested:
            return
        if self._channel_state == "AUTH_FAILED":
            return
        if code == 4001:
            self._channel_state = "AUTH_FAILED"
            return
        self._channel_state = "RECONNECTING"
        self._reconnect_task = asyncio.ensure_future(self._reconnect_loop())

    async def _reconnect_loop(self) -> None:
        try:
            while (
                not self._disconnect_requested
                and self._channel_state != "AUTH_FAILED"
            ):
                idx = min(self._reconnect_attempt, len(RECONNECT_BACKOFF) - 1)
                backoff = RECONNECT_BACKOFF[idx]
                self._reconnect_attempt += 1

                await asyncio.sleep(backoff)
                if self._disconnect_requested:
                    break

                # Proactively refresh token if needed
                try:
                    await self._maybe_refresh_token()
                except CortexError:
                    self._channel_state = "AUTH_FAILED"
                    return

                try:
                    await self._open_channel()
                except Exception:
                    continue  # retry after next backoff

                # Re-attach session to the new transport
                self._session.set_transport(self._transport, self._send_timeout)

                # Resync with timeout
                try:
                    await asyncio.wait_for(
                        self._session.send_resync(),
                        timeout=self._resync_timeout,
                    )
                except Exception:
                    self._transport.close()
                    continue

                # Reconnect successful — restart liveness + token refresh
                self._start_liveness()
                self._schedule_token_refresh()
                return
        except asyncio.CancelledError:
            pass

    async def _maybe_refresh_token(self) -> None:
        if not self._refresh_token:
            raise make_error("auth_refresh_failed", "No refresh token")
        if not self._access_token or is_token_expiring_soon(self._access_token):
            self._access_token = await refresh_access_token(
                self._refresh_token,
                auth_base_url=self._auth_url,
            )

    def _require_session_id(self, session_id: str | None = None) -> str:
        effective_session_id = session_id or self.session_id
        if not effective_session_id:
            raise make_error("session_not_ready", "Session is not ready")
        return effective_session_id

    def _require_runtime_http_base_url(self) -> str:
        if not self._runtime_http_base_url:
            raise make_error("file_api_unavailable", "Runtime file API is unavailable")
        return self._runtime_http_base_url

    def _require_cp_api_url(self) -> str:
        if not self._cp_api_url:
            raise make_error("file_api_unavailable", "Control Plane file API is unavailable")
        return self._cp_api_url

    async def _request_json(self, url: str, *, method: str = "GET") -> dict[str, object]:
        assert self._access_token is not None
        async with httpx.AsyncClient(follow_redirects=True) as client:
            resp = await client.request(
                method,
                url,
                headers={"Authorization": f"Bearer {self._access_token}"},
            )
        if not resp.is_success:
            _raise_file_response_error(resp.status_code)
        body = resp.json()
        if not isinstance(body, dict):
            raise make_error("file_operation_failed", "File API returned a non-object response")
        return body

    async def _request_bytes(self, url: str) -> bytes:
        assert self._access_token is not None
        async with httpx.AsyncClient(follow_redirects=True) as client:
            resp = await client.get(
                url,
                headers={"Authorization": f"Bearer {self._access_token}"},
            )
        if not resp.is_success:
            _raise_file_response_error(resp.status_code)
        return resp.content


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _derive_upload_url_from_ws_url(ws_url: str | None) -> str:
    base_url = _derive_runtime_http_base_url_from_ws_url(ws_url)
    if not base_url:
        return "/upload"
    return f"{base_url}/upload"


def _derive_runtime_http_base_url_from_ws_url(ws_url: str | None) -> str:
    if not ws_url:
        return ""

    parsed = urlsplit(ws_url)
    scheme = parsed.scheme.lower()
    http_scheme = "https" if scheme == "wss" else "http" if scheme == "ws" else scheme
    return urlunsplit((http_scheme, parsed.netloc, "", "", "")).rstrip("/")


def _derive_runtime_http_base_url_from_http_url(http_url: str | None) -> str:
    if not http_url:
        return ""
    parsed = urlsplit(http_url)
    if parsed.scheme.lower() not in {"http", "https"}:
        return ""
    return urlunsplit((parsed.scheme, parsed.netloc, "", "", "")).rstrip("/")


def _normalize_optional_base_url(url: object) -> str | None:
    if not isinstance(url, str):
        return None
    normalized = url.rstrip("/")
    return normalized or None


def _with_query_params(url: str, params: dict[str, object]) -> str:
    parsed = urlsplit(url)
    current = dict(
        item.split("=", 1) if "=" in item else (item, "")
        for item in parsed.query.split("&")
        if item
    )
    for key, value in params.items():
        current[key] = str(value)
    query = urlencode(current)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, query, parsed.fragment))


def _raise_file_response_error(status_code: int) -> None:
    if status_code in (401,):
        raise make_error("auth_invalid", "File API authentication failed")
    if status_code == 403:
        raise make_error("file_access_denied", "File access denied")
    if status_code == 404:
        raise make_error("file_not_found", "File not found")
    if status_code == 410:
        raise make_error("file_expired", "File expired")
    raise make_error("file_operation_failed", f"File operation failed with status {status_code}")
