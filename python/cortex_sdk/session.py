from __future__ import annotations

import json
import uuid
from typing import Callable

from .constants import SCHEMA_VERSION
from .errors import make_error, lookup_error, CortexError
from .files import normalize_session_file_attachments
from .transport import Transport
from .types import (
    CortexMessage,
    EscalationReplyAction,
    EscalationReplyContent,
    RuntimeBootstrap,
    SessionFileAttachmentInput,
    SessionState,
)


_TERMINAL_STATES: set[SessionState] = {
    "COMPLETED",
    "FAILED",
    "STOPPED",
    "TIMEOUT",
    "CANCELLED",
}
_LIFECYCLE_STATE_MAP: dict[str, SessionState] = {
    "active": "ACTIVE",
    "waiting": "WAITING",
    "completed": "COMPLETED",
    "failed": "FAILED",
    "stopped": "STOPPED",
    "timeout": "TIMEOUT",
    "cancelled": "CANCELLED",
}


class SessionManager:
    """Manages session state and envelope construction/parsing."""

    def __init__(
        self,
        on_message: Callable[[CortexMessage], None],
        on_fatal_error: Callable[[CortexError], None],
    ) -> None:
        self._on_message = on_message
        self._on_fatal_error = on_fatal_error

        self._session_id: str | None = None
        self._session_state: SessionState = "CREATED"
        self._last_seq: int = 0
        self._transport: Transport | None = None
        self._send_timeout: float = 10.0

    def _set_session_state(self, next_state: SessionState) -> None:
        if self._session_state in _TERMINAL_STATES and self._session_state != next_state:
            return
        self._session_state = next_state

    # ── accessors ─────────────────────────────────────────────────────────────

    @property
    def session_id(self) -> str | None:
        return self._session_id

    @property
    def session_state(self) -> SessionState:
        return self._session_state

    @property
    def last_seq(self) -> int:
        return self._last_seq

    # ── configuration ─────────────────────────────────────────────────────────

    def set_transport(self, transport: Transport, send_timeout: float) -> None:
        self._transport = transport
        self._send_timeout = send_timeout

    # ── outbound helpers ──────────────────────────────────────────────────────

    def _build_envelope(
        self, type_: str, payload: dict[str, object]
    ) -> dict[str, object]:
        env: dict[str, object] = {
            "type": type_,
            "schema": SCHEMA_VERSION,
            "payload": payload,
            "ts": _now_iso(),
        }
        if self._session_id:
            env["session_id"] = self._session_id
        return env

    async def _send(self, envelope: dict[str, object]) -> None:
        if self._transport is None:
            raise make_error("transport_send_timeout", "No transport configured")
        await self._transport.send_json(envelope)

    async def send_init(self, bootstrap: RuntimeBootstrap) -> None:
        """Send system::init — intentionally omits session_id."""
        self._session_state = "INITIALIZING"
        envelope: dict[str, object] = {
            "type": "system::init",
            "schema": SCHEMA_VERSION,
            "payload": dict(bootstrap),
            "meta": {"client_msg_id": f"cli_init_{uuid.uuid4()}"},
            "ts": _now_iso(),
        }
        await self._send(envelope)

    async def send_resync(self) -> None:
        await self._send(
            self._build_envelope("system::resync", {"last_seq": self._last_seq})
        )

    async def send_stop(self) -> None:
        await self._send(self._build_envelope("sandbox::stop", {}))

    async def send_chat_message(
        self, content: str, attachments: list[SessionFileAttachmentInput] | None
    ) -> None:
        payload: dict[str, object] = {"content": content, "role": "user"}
        if attachments:
            payload["meta"] = {"attachments": normalize_session_file_attachments(attachments)}
        await self._send(self._build_envelope("chat::message", payload))

    async def send_escalation_reply(
        self,
        escalation_id: str,
        wait_token: str,
        action: EscalationReplyAction,
        content: EscalationReplyContent | None = None,
        meta: dict[str, object] | None = None,
    ) -> None:
        payload = _build_escalation_reply_payload(
            escalation_id=escalation_id,
            wait_token=wait_token,
            action=action,
            content=content,
            meta=meta,
        )
        await self._send(self._build_envelope("escalation::reply", payload))

    # ── inbound handling ──────────────────────────────────────────────────────

    def handle_incoming(self, raw: str) -> None:
        """Parse a raw JSON frame and dispatch callbacks."""
        try:
            parsed: dict[str, object] = json.loads(raw)
            msg: CortexMessage = parsed  # type: ignore[assignment]
        except Exception:
            return  # malformed frame — ignore

        self.handle_message(msg)

    def handle_message(self, msg: CortexMessage) -> None:
        # Learn session_id from first server message
        if not self._session_id and msg.get("session_id"):
            self._session_id = msg["session_id"]
            if self._session_state not in _TERMINAL_STATES:
                self._session_state = "ACTIVE"

        # Track highest sequence number
        seq = msg.get("seq")
        if isinstance(seq, int) and seq > self._last_seq:
            self._last_seq = seq

        self._update_session_state(msg)

        # Fatal error detection
        if msg.get("type") == "system::error":
            self._handle_system_error(msg["payload"])

        self._on_message(msg)

    def _handle_system_error(self, payload: dict[str, object]) -> None:
        code = payload.get("code", "session_terminal")
        message = payload.get("message", "Runtime error")
        entry = lookup_error(str(code))
        if entry and entry.fatal:
            self._set_session_state("FAILED")
            err = make_error(str(code), str(message))
            self._on_fatal_error(err)

    def _update_session_state(self, msg: CortexMessage) -> None:
        msg_type = msg.get("type")

        if msg_type == "sandbox::snapshot":
            state = msg["payload"].get("state")
            if isinstance(state, str) and state.lower() == "waiting":
                self._set_session_state("WAITING")
            return

        if msg_type == "sandbox::lifecycle":
            status = msg["payload"].get("status")
            if isinstance(status, str):
                next_state = _LIFECYCLE_STATE_MAP.get(status.lower())
                if next_state is not None:
                    self._set_session_state(next_state)
            return

        if msg_type == "system::error":
            code = msg["payload"].get("code")
            if isinstance(code, str):
                entry = lookup_error(code)
                if entry and entry.fatal:
                    self._set_session_state("FAILED")


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _is_plain_object(value: object | None) -> bool:
    return isinstance(value, dict)


def _validate_escalation_reply(
    escalation_id: str,
    wait_token: str,
    action: str,
    content: EscalationReplyContent | None,
) -> None:
    if not isinstance(escalation_id, str) or escalation_id.strip() == "":
        raise make_error("transport_protocol_violation", "escalation_id is required")
    if not isinstance(wait_token, str) or wait_token.strip() == "":
        raise make_error("transport_protocol_violation", "wait_token is required")
    if action not in {"continue", "operator_input", "reply_user"}:
        raise make_error("transport_protocol_violation", f"Unsupported escalation reply action: {action}")
    if action == "continue" and content is None:
        return
    if isinstance(content, str):
        return
    if _is_plain_object(content):
        return
    raise make_error(
        "transport_protocol_violation",
        f"content must be a string or object for escalation action {action}",
    )


def _build_escalation_reply_payload(
    *,
    escalation_id: str,
    wait_token: str,
    action: EscalationReplyAction,
    content: EscalationReplyContent | None,
    meta: dict[str, object] | None,
) -> dict[str, object]:
    _validate_escalation_reply(escalation_id, wait_token, action, content)
    payload: dict[str, object] = {
        "escalation_id": escalation_id.strip(),
        "action": action,
        "wait_token": wait_token.strip(),
    }
    if content is not None:
        payload["content"] = content
    if meta is not None:
        payload["meta"] = meta
    return payload
