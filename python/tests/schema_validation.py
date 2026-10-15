from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft7Validator, FormatChecker


ROOT = Path(__file__).resolve().parents[2]
SCHEMA_DIR = ROOT / "shared" / "schema"

PAYLOAD_SCHEMA_MAP: dict[str, str] = {
    "system::init": "system.init.json",
    "system::resync": "system.resync.json",
    "system::ping": "system.ping.json",
    "chat::message": "chat.message.json",
    "sandbox::continue": "sandbox.continue.json",
    "sandbox::stop": "sandbox.stop.json",
    "escalation::reply": "escalation.reply.json",
}


class SchemaViolation(dict[str, object]):
    pass


@lru_cache(maxsize=None)
def _load_validator(schema_name: str) -> Draft7Validator:
    schema = json.loads((SCHEMA_DIR / schema_name).read_text(encoding="utf-8"))
    return Draft7Validator(schema, format_checker=FormatChecker())


def _format_errors(errors: list[Any]) -> list[str]:
    messages: list[str] = []
    for error in errors:
        location = "/" + "/".join(str(part) for part in error.absolute_path)
        if location == "/":
            location = "/"
        messages.append(f"{location} {error.message}".strip())
    return messages


def validate_outbound_envelope(envelope: dict[str, object]) -> list[SchemaViolation]:
    violations: list[SchemaViolation] = []
    message_type = envelope.get("type")
    message_type_str = message_type if isinstance(message_type, str) else "unknown"

    envelope_validator = _load_validator("envelope.json")
    envelope_errors = sorted(envelope_validator.iter_errors(envelope), key=str)
    if envelope_errors:
        violations.append(SchemaViolation({
            "message_type": message_type_str,
            "schema_name": "envelope.json",
            "validation_errors": _format_errors(envelope_errors),
            "envelope": envelope,
        }))

    payload_schema = PAYLOAD_SCHEMA_MAP.get(message_type_str)
    if payload_schema is None:
        return violations

    payload_validator = _load_validator(payload_schema)
    payload = envelope.get("payload")
    payload_errors = sorted(payload_validator.iter_errors(payload), key=str)
    if payload_errors:
        violations.append(SchemaViolation({
            "message_type": message_type_str,
            "schema_name": payload_schema,
            "validation_errors": _format_errors(payload_errors),
            "envelope": envelope,
        }))

    return violations


RUNTIME_CHAT_SCHEMA_MAP: dict[str, str] = {
    "chat::answer": "chat.answer.json",
    "chat::partial": "chat.partial.json",
    "chat::echo": "chat.echo.json",
}


def validate_server_chat_payload(envelope: dict[str, object]) -> list[str]:
    """Server-sent chat::answer/chat::partial/chat::echo payloads must match the
    Runtime serialization pinned in the shared schemas, so test doubles cannot drift
    from the real wire shape. meta.attachments is left out: adversarial attachment
    tests send hostile descriptors on purpose and have their own vectors."""
    message_type = envelope.get("type")
    schema_name = RUNTIME_CHAT_SCHEMA_MAP.get(message_type) if isinstance(message_type, str) else None
    if schema_name is None:
        return []
    payload = envelope.get("payload")
    if isinstance(payload, dict) and isinstance(payload.get("meta"), dict):
        payload = {**payload, "meta": {k: v for k, v in payload["meta"].items() if k != "attachments"}}
    errors = sorted(_load_validator(schema_name).iter_errors(payload), key=str)
    return [f"{message_type} {error}" for error in _format_errors(errors)]
