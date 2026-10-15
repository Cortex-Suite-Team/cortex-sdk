from __future__ import annotations

from typing import Callable, Literal

from typing_extensions import TypedDict, NotRequired, Required


class RuntimeBootstrap(TypedDict):
    execution_mode: str
    bundle_url: str
    checksum: str
    artifact_id: NotRequired[str | None]
    artifact_kind: NotRequired[str | None]
    run_mode: NotRequired[str | None]
    trigger_payload: NotRequired[dict[str, object] | None]


class AuthTokenResponse(TypedDict):
    ws_url: str
    access_token: str
    refresh_token: str
    cp_api_url: NotRequired[str | None]
    runtime_bootstrap: RuntimeBootstrap


FileScope = Literal["session", "project"]


SessionFileOwnerRole = Literal["user", "assistant", "operator", "system"]
SessionFileDirection = Literal["inbound", "outbound", "internal"]
SessionFileState = Literal["available", "expired", "deleted", "quarantined"]
SessionFileMessageRefKind = Literal["client_msg_id", "turn"]


class SessionFileDescriptor(TypedDict):
    """Public session-file descriptor from message ``payload.meta.attachments``
    and ``file::list``. ``message_ref`` is the owning message's ``client_msg_id``
    (user uploads) or turn id (assistant-generated files). Download with
    ``download_file(file_ref)``."""

    file_ref: str
    filename: str
    content_type: str
    size: int
    owner_role: SessionFileOwnerRole
    direction: SessionFileDirection
    state: SessionFileState
    message_ref: NotRequired[str]
    message_ref_kind: NotRequired[SessionFileMessageRefKind]


class FileRef(TypedDict, total=False):
    file_ref: Required[str]
    filename: str
    content_type: str
    size: int
    owner_role: SessionFileOwnerRole
    direction: SessionFileDirection
    state: SessionFileState
    message_ref: str
    message_ref_kind: SessionFileMessageRefKind
    # Project (Control Plane) files only.
    scope_type: str
    scope_id: str
    status: str
    created_at: str
    updated_at: str
    expires_at: str | None


class FileListResult(TypedDict):
    files: list[FileRef]
    total: int


class FileReadyEvent(TypedDict, total=False):
    file_ref: Required[str]
    filename: str
    content_type: str
    size: int
    scope_type: str
    scope_id: str


class SessionFileAttachment(TypedDict):
    file_ref: str
    filename: NotRequired[str]
    content_type: NotRequired[str]
    size: NotRequired[int | float]


SessionFileAttachmentInput = str | SessionFileAttachment


class CortexMessage(TypedDict):
    type: str
    schema: str
    session_id: str
    seq: NotRequired[int | None]
    payload: dict[str, object]
    meta: NotRequired[dict[str, object] | None]
    ts: str


SessionState = Literal[
    "CREATED",
    "INITIALIZING",
    "ACTIVE",
    "WAITING",
    "COMPLETED",
    "FAILED",
    "STOPPED",
    "TIMEOUT",
    "CANCELLED",
]

ChannelState = Literal[
    "CONNECTING",
    "OPEN",
    "STALE",
    "RECONNECTING",
    "CLOSED",
    "AUTH_FAILED",
]

MessageCallback = Callable[["CortexMessage"], None]

EscalationReplyAction = Literal["continue", "operator_input", "reply_user"]
EscalationReplyContent = str | dict[str, object]


class ReplyEscalationOptions(TypedDict):
    escalation_id: str
    wait_token: str
    action: EscalationReplyAction
    content: NotRequired[EscalationReplyContent]
    meta: NotRequired[dict[str, object]]
