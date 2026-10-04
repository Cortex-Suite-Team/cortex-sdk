from __future__ import annotations

import re

from .errors import make_error
from .types import FileListResult, FileRef, SessionFileAttachmentInput


_FILE_REF_PATTERN = re.compile(r"^sf_[A-Za-z0-9][A-Za-z0-9_-]*$")
_ATTACHMENT_KEYS = {"file_ref", "filename", "content_type", "size"}
_FILE_DESCRIPTOR_KEYS = (
    "filename", "content_type", "size", "scope_type", "scope_id", "status",
    "created_at", "updated_at", "expires_at",
)


def require_session_file_ref(value: object, context: str = "file_ref") -> str:
    if not isinstance(value, str) or _FILE_REF_PATTERN.fullmatch(value) is None:
        raise make_error("file_operation_failed", f"{context} must be a canonical sf_ file_ref")
    return value


def normalize_session_file_attachments(
    attachments: list[SessionFileAttachmentInput],
) -> list[dict[str, object]]:
    normalized: list[dict[str, object]] = []
    for index, attachment in enumerate(attachments):
        if isinstance(attachment, str):
            normalized.append({"file_ref": require_session_file_ref(attachment, f"attachments[{index}]")})
            continue
        if not isinstance(attachment, dict):
            raise make_error("transport_protocol_violation", f"attachments[{index}] must be a file_ref or attachment object")
        unsupported = sorted(set(attachment) - _ATTACHMENT_KEYS)
        if unsupported:
            raise make_error(
                "transport_protocol_violation",
                f"attachments[{index}] contains unsupported fields: {', '.join(unsupported)}",
            )
        item: dict[str, object] = {
            "file_ref": require_session_file_ref(attachment.get("file_ref"), f"attachments[{index}].file_ref")
        }
        for key in ("filename", "content_type"):
            value = attachment.get(key)
            if value is not None:
                if not isinstance(value, str):
                    raise make_error("transport_protocol_violation", f"attachments[{index}].{key} must be a string")
                item[key] = value
        size = attachment.get("size")
        if size is not None:
            if not isinstance(size, (int, float)) or isinstance(size, bool) or size < 0:
                raise make_error("transport_protocol_violation", f"attachments[{index}].size must be a non-negative number")
            item["size"] = size
        normalized.append(item)
    return normalized


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
    if not isinstance(value, dict) or not isinstance(value.get("files"), list) or not isinstance(value.get("total"), int):
        raise make_error("file_operation_failed", "File list response is missing files or total")
    return {
        "files": [parse_public_file_ref(item) for item in value["files"]],
        "total": value["total"],
    }
