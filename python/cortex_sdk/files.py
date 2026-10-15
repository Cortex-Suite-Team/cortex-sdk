from __future__ import annotations

import re
from typing import Mapping

from .constants import MAX_ATTACHMENTS_PER_MESSAGE
from .errors import make_error
from .types import CortexMessage, FileListResult, FileRef, SessionFileAttachmentInput, SessionFileDescriptor


_FILE_REF_PATTERN = re.compile(r"^sf_[A-Za-z0-9][A-Za-z0-9_-]*$")
_ATTACHMENT_KEYS = {"file_ref", "filename", "content_type", "size"}
_FILE_DESCRIPTOR_KEYS = (
    "filename", "content_type", "size", "scope_type", "scope_id", "status",
    "created_at", "updated_at", "expires_at",
)
_OWNER_ROLES = {"user", "assistant", "operator", "system"}
_DIRECTIONS = {"inbound", "outbound", "internal"}
_STATES = {"available", "expired", "deleted", "quarantined"}
_MESSAGE_REF_KINDS = {"client_msg_id", "turn"}
# An identity field must never carry an internal File Layer identity.
_INTERNAL_VALUE_PREFIXES = ("fi_", "sn_")


def require_session_file_ref(value: object, context: str = "file_ref") -> str:
    if not isinstance(value, str) or _FILE_REF_PATTERN.fullmatch(value) is None:
        raise make_error("file_operation_failed", f"{context} must be a canonical sf_ file_ref")
    return value


def normalize_session_file_attachments(
    attachments: list[SessionFileAttachmentInput],
) -> list[dict[str, object]]:
    if not isinstance(attachments, list):
        raise make_error("invalid_attachment", "attachments must be a list")
    if len(attachments) > MAX_ATTACHMENTS_PER_MESSAGE:
        raise make_error(
            "too_many_attachments",
            f"At most {MAX_ATTACHMENTS_PER_MESSAGE} file(s) may be attached per message.",
        )
    normalized: list[dict[str, object]] = []
    seen: set[str] = set()
    for index, attachment in enumerate(attachments):
        item = _normalize_attachment(attachment, index)
        file_ref = item["file_ref"]
        assert isinstance(file_ref, str)
        if file_ref in seen:
            raise make_error("invalid_attachment", f"attachments[{index}] duplicates {file_ref}")
        seen.add(file_ref)
        normalized.append(item)
    return normalized


def _normalize_attachment(attachment: object, index: int) -> dict[str, object]:
    if isinstance(attachment, str):
        return {"file_ref": _require_attachment_ref(attachment, f"attachments[{index}]")}
    if not isinstance(attachment, dict):
        raise make_error("invalid_attachment", f"attachments[{index}] must be a file_ref or attachment object")
    unsupported = sorted(set(attachment) - _ATTACHMENT_KEYS)
    if unsupported:
        raise make_error(
            "invalid_attachment",
            f"attachments[{index}] contains unsupported fields: {', '.join(unsupported)}",
        )
    item: dict[str, object] = {
        "file_ref": _require_attachment_ref(attachment.get("file_ref"), f"attachments[{index}].file_ref")
    }
    for key in ("filename", "content_type"):
        value = attachment.get(key)
        if value is not None:
            if not isinstance(value, str):
                raise make_error("invalid_attachment", f"attachments[{index}].{key} must be a string")
            item[key] = value
    size = attachment.get("size")
    if size is not None:
        if not isinstance(size, (int, float)) or isinstance(size, bool) or size < 0:
            raise make_error("invalid_attachment", f"attachments[{index}].size must be a non-negative number")
        item["size"] = size
    return item


def _require_attachment_ref(value: object, context: str) -> str:
    if not isinstance(value, str) or _FILE_REF_PATTERN.fullmatch(value) is None:
        raise make_error("invalid_attachment", f"{context} must be a canonical sf_ file_ref")
    return value


def parse_public_attachment(value: object) -> SessionFileDescriptor | None:
    """Explicit public projection of one session-file descriptor.

    Only the nine public fields survive; anything else (internal identity,
    scope, storage keys, tickets, URLs) is dropped. A descriptor whose public
    fields are missing or invalid is not a public file and yields None.
    """
    if not isinstance(value, dict):
        return None
    file_ref = value.get("file_ref")
    filename = value.get("filename")
    content_type = value.get("content_type")
    size = value.get("size")
    owner_role = value.get("owner_role")
    direction = value.get("direction")
    state = value.get("state")
    if not isinstance(file_ref, str) or _FILE_REF_PATTERN.fullmatch(file_ref) is None:
        return None
    if not _is_non_empty_string(filename) or not _is_non_empty_string(content_type):
        return None
    if type(size) is not int or size < 0:
        return None
    if not (_is_member(owner_role, _OWNER_ROLES) and _is_member(direction, _DIRECTIONS) and _is_member(state, _STATES)):
        return None
    descriptor: SessionFileDescriptor = {
        "file_ref": file_ref,
        "filename": filename,  # type: ignore[typeddict-item]
        "content_type": content_type,  # type: ignore[typeddict-item]
        "size": size,
        "owner_role": owner_role,  # type: ignore[typeddict-item]
        "direction": direction,  # type: ignore[typeddict-item]
        "state": state,  # type: ignore[typeddict-item]
    }
    message_ref = value.get("message_ref")
    message_ref_kind = value.get("message_ref_kind")
    if message_ref is not None:
        if not _is_public_identity(message_ref):
            return None
        descriptor["message_ref"] = message_ref  # type: ignore[typeddict-item]
    if message_ref_kind is not None:
        if not _is_member(message_ref_kind, _MESSAGE_REF_KINDS):
            return None
        descriptor["message_ref_kind"] = message_ref_kind  # type: ignore[typeddict-item]
    return descriptor


def _is_member(value: object, allowed: set[str]) -> bool:
    return isinstance(value, str) and value in allowed


def _is_non_empty_string(value: object) -> bool:
    return isinstance(value, str) and bool(value)


def _is_public_identity(value: object) -> bool:
    return isinstance(value, str) and bool(value) and not value.startswith(_INTERNAL_VALUE_PREFIXES)


def _message_file_binding(message: Mapping[str, object]) -> tuple[str, str, str, str | None] | None:
    """(owner_role, direction, message_ref_kind, message_ref) owned by this message type."""
    payload = message.get("payload")
    payload = payload if isinstance(payload, dict) else {}
    message_type = message.get("type")
    if message_type in ("chat::answer", "chat::partial"):
        return "assistant", "outbound", "turn", _turn_identity(payload)
    if message_type in ("chat::echo", "chat::message"):
        meta = payload.get("meta")
        client_msg_id = meta.get("client_msg_id") if isinstance(meta, dict) else None
        message_ref = client_msg_id if isinstance(client_msg_id, str) and client_msg_id else None
        return "user", "inbound", "client_msg_id", message_ref
    return None


def _turn_identity(payload: dict[str, object]) -> str | None:
    turn_id = payload.get("turn_id")
    if isinstance(turn_id, str) and turn_id:
        return turn_id
    turn = payload.get("turn")
    if type(turn) is int and turn >= 0:
        return str(turn)
    return None


def parse_message_attachments(message: Mapping[str, object]) -> list[SessionFileDescriptor]:
    """Public files that belong to this message, in the order the server sent them.

    An assistant answer only owns assistant/outbound files bound to its turn; a
    user message only owns user/inbound files bound to its client_msg_id. A
    descriptor of another owner, direction or message (for example a user upload
    re-exported inside an answer), an invalid descriptor or a repeated file_ref
    is excluded.
    """
    payload = message.get("payload")
    meta = payload.get("meta") if isinstance(payload, dict) else None
    raw = meta.get("attachments") if isinstance(meta, dict) else None
    if not isinstance(raw, list):
        return []
    binding = _message_file_binding(message)
    seen: set[str] = set()
    result: list[SessionFileDescriptor] = []
    for item in raw:
        descriptor = parse_public_attachment(item)
        if descriptor is None or descriptor["file_ref"] in seen:
            continue
        if binding is not None and not _belongs_to_message(descriptor, binding):
            continue
        seen.add(descriptor["file_ref"])
        result.append(descriptor)
    return result


def _belongs_to_message(
    descriptor: SessionFileDescriptor, binding: tuple[str, str, str, str | None]
) -> bool:
    owner_role, direction, message_ref_kind, message_ref = binding
    if descriptor["owner_role"] != owner_role or descriptor["direction"] != direction:
        return False
    if "message_ref_kind" in descriptor and descriptor["message_ref_kind"] != message_ref_kind:
        return False
    if message_ref is not None and "message_ref" in descriptor and descriptor["message_ref"] != message_ref:
        return False
    return True


def sanitize_message_attachments(message: CortexMessage) -> CortexMessage:
    """Replace payload.meta.attachments of an inbound message with its public projection."""
    payload = message.get("payload")
    meta = payload.get("meta") if isinstance(payload, dict) else None
    if isinstance(meta, dict) and "attachments" in meta:
        meta["attachments"] = parse_message_attachments(message)
    return message


def parse_public_file_ref(value: object) -> FileRef:
    if not isinstance(value, dict):
        raise make_error("file_operation_failed", "File API response contained an invalid descriptor")
    result: dict[str, object] = {
        "file_ref": require_session_file_ref(value.get("file_ref"), "File API response file_ref")
    }
    for key in _FILE_DESCRIPTOR_KEYS:
        if key in value:
            result[key] = value[key]
    return result  # type: ignore[return-value]


def parse_public_file_list(value: object) -> FileListResult:
    files, total = _require_file_list(value)
    return {
        "files": [parse_public_file_ref(item) for item in files],
        "total": total,
    }


def parse_session_file_list(value: object) -> FileListResult:
    """Session file::list.result: every entry must be a valid public descriptor."""
    files, total = _require_file_list(value)
    parsed: list[FileRef] = []
    for item in files:
        descriptor = parse_public_attachment(item)
        if descriptor is None:
            raise make_error("file_operation_failed", "File list response contained an invalid descriptor")
        parsed.append(descriptor)  # type: ignore[arg-type]
    return {"files": parsed, "total": total}


def _require_file_list(value: object) -> tuple[list[object], int]:
    if not isinstance(value, dict) or not isinstance(value.get("files"), list) or not isinstance(value.get("total"), int):
        raise make_error("file_operation_failed", "File list response is missing files or total")
    return value["files"], value["total"]
