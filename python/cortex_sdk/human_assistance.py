"""Separate, session-neutral Human Assistance responder inbox."""

from __future__ import annotations

import copy
import json
import re
from collections.abc import Mapping
from collections.abc import Set as AbstractSet
from datetime import datetime, timezone
from typing import cast

from .errors import make_error
from .types import (
    HumanAssistanceAction,
    HumanAssistanceNotification,
    HumanAssistanceRequest,
    HumanAssistanceStatus,
)

_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_DEADLINE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$")
_TERMINAL = {"resolved", "expired", "revoked", "delivery_failed"}
_STATUSES = {"reply_accepted", "reply_rejected", *_TERMINAL}
_REASONS = {"unauthorized", "duplicate", "invalid_answer", "late"}
_MAX_REQUESTS = 64


def _id(value: object) -> bool:
    return isinstance(value, str) and _ID.fullmatch(value) is not None


def _keys(value: dict[str, object], required: set[str], optional: AbstractSet[str] = frozenset()) -> bool:
    return required <= value.keys() and value.keys() <= required | optional


def _deadline(value: object) -> datetime | None:
    if not isinstance(value, str) or _DEADLINE.fullmatch(value) is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def _request(value: object) -> HumanAssistanceRequest | None:
    required = {"version", "request_id", "question", "options", "allow_text", "deadline_at", "status"}
    if not isinstance(value, dict) or not _keys(value, required):
        return None
    question, options = value["question"], value["options"]
    if (type(value["version"]) is not int or value["version"] != 1
            or not _id(value["request_id"]) or value["status"] != "pending"
            or not isinstance(question, str) or not question.strip() or len(question) > 4096
            or type(value["allow_text"]) is not bool or not isinstance(options, list)
            or len(options) > 32 or not (options or value["allow_text"])
            or _deadline(value["deadline_at"]) is None):
        return None
    seen: set[str] = set()
    for option in options:
        if (not isinstance(option, dict) or not _keys(option, {"id", "label"})
                or not _id(option["id"]) or not isinstance(option["label"], str)
                or not option["label"].strip() or len(option["label"]) > 256
                or option["id"] in seen):
            return None
        seen.add(option["id"])
    return cast(HumanAssistanceRequest, value)


def _status(value: object) -> HumanAssistanceStatus | None:
    required = {"version", "request_id", "status"}
    if (not isinstance(value, dict) or not _keys(value, required, {"client_reply_id", "reason"})
            or type(value["version"]) is not int or value["version"] != 1
            or not _id(value["request_id"]) or not isinstance(value["status"], str)
            or value["status"] not in _STATUSES):
        return None
    if value["status"] in {"reply_accepted", "reply_rejected"}:
        if not _id(value.get("client_reply_id")):
            return None
    elif "client_reply_id" in value:
        return None
    if value["status"] == "reply_rejected":
        if not isinstance(value.get("reason"), str) or value["reason"] not in _REASONS:
            return None
    elif "reason" in value:
        return None
    return cast(HumanAssistanceStatus, value)


class HumanAssistanceInbox:
    def __init__(self) -> None:
        self._entries: dict[str, tuple[HumanAssistanceRequest, str]] = {}
        self._terminal_before_request: dict[str, None] = {}
        self._terminal_overflow = False
        self._seen_statuses: dict[str, set[str]] = {}
        self._submissions: dict[str, str] = {}

    def clear(self) -> None:
        self._entries.clear()
        self._terminal_before_request.clear()
        self._terminal_overflow = False
        self._seen_statuses.clear()
        self._submissions.clear()

    def requests(self) -> list[HumanAssistanceRequest]:
        return [copy.deepcopy(row[0]) for row in self._entries.values() if row[1] == "pending"]

    def _remember_terminal(self, request_id: str) -> None:
        if request_id in self._terminal_before_request:
            return
        if len(self._terminal_before_request) >= _MAX_REQUESTS:
            self._terminal_overflow = True
            return
        self._terminal_before_request[request_id] = None

    def handle(self, message: Mapping[str, object], current_session_id: str | None) -> HumanAssistanceNotification | None:
        if (not current_session_id or message.get("schema") != "1.0"
                or message.get("session_id", current_session_id) != current_session_id):
            return None
        payload = message.get("payload")
        if message.get("type") == "human_assistance::request":
            parsed = _request(payload)
            if (parsed is None or parsed["request_id"] in self._entries
                    or self._terminal_overflow or parsed["request_id"] in self._terminal_before_request):
                return None
            if len(self._entries) >= _MAX_REQUESTS:
                terminal = next((key for key, row in self._entries.items() if row[1] in _TERMINAL), None)
                if terminal is not None:
                    self._remember_terminal(terminal)
                    del self._entries[terminal]
                    del self._seen_statuses[terminal]
            if len(self._entries) >= _MAX_REQUESTS:
                return None
            self._entries[parsed["request_id"]] = (copy.deepcopy(parsed), "pending")
            self._seen_statuses[parsed["request_id"]] = set()
            return {"type": "human_assistance::request", "payload": copy.deepcopy(parsed)}
        if message.get("type") == "human_assistance::status":
            parsed_status = _status(payload)
            if parsed_status is None:
                return None
            row = self._entries.get(parsed_status["request_id"])
            if row is None:
                if parsed_status["status"] in _TERMINAL:
                    self._remember_terminal(parsed_status["request_id"])
                return None
            if row[1] in _TERMINAL:
                return None
            signature = f"{parsed_status['status']}:{parsed_status.get('client_reply_id', '')}:{parsed_status.get('reason', '')}"
            if signature in self._seen_statuses[parsed_status["request_id"]]:
                return None
            self._seen_statuses[parsed_status["request_id"]].add(signature)
            self._entries[parsed_status["request_id"]] = (
                row[0], parsed_status["status"] if parsed_status["status"] in _TERMINAL else row[1],
            )
            return {"type": "human_assistance::status", "payload": copy.deepcopy(parsed_status)}
        return None

    def reply(self, *, request_id: str, client_reply_id: str, action: HumanAssistanceAction,
              option_id: str | None, text: str | None) -> dict[str, object]:
        row = self._entries.get(request_id)
        if not _id(request_id) or not _id(client_reply_id) or row is None or row[1] != "pending":
            raise make_error("transport_protocol_violation", "Unknown or inactive HA request")
        deadline = _deadline(row[0]["deadline_at"])
        assert deadline is not None
        if datetime.now(timezone.utc) >= deadline:
            raise make_error("transport_protocol_violation", "HA request expired")
        if ((option_id is not None and (not _id(option_id) or not any(
                choice["id"] == option_id for choice in row[0]["options"])))
                or (text is not None and (not isinstance(text, str) or not text.strip()
                    or len(text) > 4096 or not row[0]["allow_text"]))
                or (action == "answer" and option_id is None and text is None)
                or (action == "refuse" and (option_id is not None or text is not None))
                or action not in ("answer", "refuse")):
            raise make_error("transport_protocol_violation", "Invalid HA answer")
        payload: dict[str, object] = {"version": 1, "request_id": request_id,
                                      "client_reply_id": client_reply_id, "action": action}
        if option_id is not None:
            payload["option_id"] = option_id
        if text is not None:
            payload["text"] = text
        fingerprint = json.dumps(payload, sort_keys=True)
        old = self._submissions.get(client_reply_id)
        if old is not None and old != fingerprint:
            raise make_error("transport_protocol_violation", "client_reply_id reused with different answer")
        self._submissions[client_reply_id] = fingerprint
        return payload
