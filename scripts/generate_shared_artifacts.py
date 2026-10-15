from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SHARED_DIR = ROOT / "shared"
JS_GENERATED_DIR = ROOT / "js" / "src" / "generated"
PY_GENERATED_DIR = ROOT / "python" / "cortex_sdk"


def _load_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def _format_ts_constants(constants: dict[str, object]) -> str:
    reconnect = ", ".join(str(value) for value in constants["RECONNECT_BACKOFF_MS"])
    return f"""// Generated from shared/constants.json. Do not edit manually.
export const DEFAULT_AUTH_URL = {json.dumps(constants["DEFAULT_AUTH_URL"])};
export const AUTH_TOKEN_PATH = {json.dumps(constants["AUTH_TOKEN_PATH"])};
export const AUTH_REFRESH_PATH = {json.dumps(constants["AUTH_REFRESH_PATH"])};
export const WS_SUBPROTOCOL = {json.dumps(constants["WS_SUBPROTOCOL"])};
export const WS_SUBPROTOCOL_JWT_PREFIX = {json.dumps(constants["WS_SUBPROTOCOL_JWT_PREFIX"])};
export const SCHEMA_VERSION = {json.dumps(constants["SCHEMA_VERSION"])};

export const DEFAULT_CONNECT_TIMEOUT_MS = {constants["DEFAULT_CONNECT_TIMEOUT_MS"]};
export const DEFAULT_SESSION_OPEN_TIMEOUT_MS = {constants["DEFAULT_SESSION_OPEN_TIMEOUT_MS"]};
export const DEFAULT_SEND_TIMEOUT_MS = {constants["DEFAULT_SEND_TIMEOUT_MS"]};
export const DEFAULT_RESYNC_TIMEOUT_MS = {constants["DEFAULT_RESYNC_TIMEOUT_MS"]};
export const DEFAULT_PING_INTERVAL_MS = {constants["DEFAULT_PING_INTERVAL_MS"]};
export const DEFAULT_PONG_TIMEOUT_MS = {constants["DEFAULT_PONG_TIMEOUT_MS"]};
export const DEFAULT_STALE_THRESHOLD_MS = {constants["DEFAULT_STALE_THRESHOLD_MS"]};
export const TOKEN_REFRESH_BUFFER_MS = {constants["TOKEN_REFRESH_BUFFER_MS"]};
export const MAX_ATTACHMENTS_PER_MESSAGE = {constants["MAX_ATTACHMENTS_PER_MESSAGE"]};

/** @deprecated Use DEFAULT_AUTH_URL + AUTH_TOKEN_PATH instead. Scheduled for removal. */
export const CORTEX_AUTH_URL = `${{DEFAULT_AUTH_URL}}${{AUTH_TOKEN_PATH}}`;
/** @deprecated Use DEFAULT_AUTH_URL + AUTH_REFRESH_PATH instead. Scheduled for removal. */
export const CORTEX_REFRESH_URL = `${{DEFAULT_AUTH_URL}}${{AUTH_REFRESH_PATH}}`;
/** @deprecated Use WS_SUBPROTOCOL instead. Scheduled for removal. */
export const WS_SUBPROTOCOL_BASE = WS_SUBPROTOCOL;

export const RECONNECT_BACKOFF_MS = [{reconnect}] as const;
"""


def _format_ts_errors(errors: dict[str, object]) -> str:
    lines = ["// Generated from sdk/shared/errors.json. Do not edit manually."]
    lines.append("export interface GeneratedErrorEntry {")
    lines.append("  readonly code: string;")
    lines.append("  readonly retryable: boolean;")
    lines.append("  readonly fatal: boolean;")
    lines.append("}")
    lines.append("")
    lines.append("export const GENERATED_ERROR_CATALOG: readonly GeneratedErrorEntry[] = [")
    for entry in errors["errors"]:
        lines.append(
            "  { code: %r, retryable: %s, fatal: %s },"
            % (entry["code"], str(entry["retryable"]).lower(), str(entry["fatal"]).lower())
        )
    lines.append("];")
    lines.append("")
    return "\n".join(lines)


def _format_py_constants(constants: dict[str, object]) -> str:
    reconnect = ", ".join(str(value) for value in constants["RECONNECT_BACKOFF_MS"])
    return f"""from __future__ import annotations

# Generated from shared/constants.json. Do not edit manually.

DEFAULT_AUTH_URL: str = {constants["DEFAULT_AUTH_URL"]!r}
AUTH_TOKEN_PATH: str = {constants["AUTH_TOKEN_PATH"]!r}
AUTH_REFRESH_PATH: str = {constants["AUTH_REFRESH_PATH"]!r}
WS_SUBPROTOCOL: str = {constants["WS_SUBPROTOCOL"]!r}
WS_SUBPROTOCOL_JWT_PREFIX: str = {constants["WS_SUBPROTOCOL_JWT_PREFIX"]!r}
SCHEMA_VERSION: str = {constants["SCHEMA_VERSION"]!r}

DEFAULT_CONNECT_TIMEOUT_MS: int = {constants["DEFAULT_CONNECT_TIMEOUT_MS"]}
DEFAULT_SESSION_OPEN_TIMEOUT_MS: int = {constants["DEFAULT_SESSION_OPEN_TIMEOUT_MS"]}
DEFAULT_SEND_TIMEOUT_MS: int = {constants["DEFAULT_SEND_TIMEOUT_MS"]}
DEFAULT_RESYNC_TIMEOUT_MS: int = {constants["DEFAULT_RESYNC_TIMEOUT_MS"]}
DEFAULT_PING_INTERVAL_MS: int = {constants["DEFAULT_PING_INTERVAL_MS"]}
DEFAULT_PONG_TIMEOUT_MS: int = {constants["DEFAULT_PONG_TIMEOUT_MS"]}
DEFAULT_STALE_THRESHOLD_MS: int = {constants["DEFAULT_STALE_THRESHOLD_MS"]}
TOKEN_REFRESH_BUFFER_MS: int = {constants["TOKEN_REFRESH_BUFFER_MS"]}
MAX_ATTACHMENTS_PER_MESSAGE: int = {constants["MAX_ATTACHMENTS_PER_MESSAGE"]}

RECONNECT_BACKOFF_MS: tuple[int, ...] = ({reconnect},)

# Deprecated compatibility aliases. Prefer DEFAULT_AUTH_URL/AUTH_TOKEN_PATH,
# DEFAULT_AUTH_URL/AUTH_REFRESH_PATH, and WS_SUBPROTOCOL directly.
CORTEX_AUTH_URL: str = DEFAULT_AUTH_URL + AUTH_TOKEN_PATH
CORTEX_REFRESH_URL: str = DEFAULT_AUTH_URL + AUTH_REFRESH_PATH
WS_SUBPROTOCOL_BASE: str = WS_SUBPROTOCOL
"""


def _format_py_errors(errors: dict[str, object]) -> str:
    lines = [
        "from __future__ import annotations",
        "",
        "from dataclasses import dataclass",
        "",
        "# Generated from sdk/shared/errors.json. Do not edit manually.",
        "",
        "@dataclass(frozen=True)",
        "class GeneratedErrorEntry:",
        "    code: str",
        "    retryable: bool",
        "    fatal: bool",
        "",
        "GENERATED_ERROR_CATALOG: tuple[GeneratedErrorEntry, ...] = (",
    ]
    for entry in errors["errors"]:
        lines.append(
            "    GeneratedErrorEntry(%r, retryable=%s, fatal=%s),"
            % (entry["code"], str(entry["retryable"]), str(entry["fatal"]))
        )
    lines.append(")")
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    constants = _load_json(SHARED_DIR / "constants.json")
    errors = _load_json(SHARED_DIR / "errors.json")

    assert isinstance(constants, dict)
    assert isinstance(errors, dict)

    JS_GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    (JS_GENERATED_DIR / "constants.ts").write_text(
        _format_ts_constants(constants),
        encoding="utf-8",
    )
    (JS_GENERATED_DIR / "errors.ts").write_text(
        _format_ts_errors(errors),
        encoding="utf-8",
    )

    (PY_GENERATED_DIR / "_generated_constants.py").write_text(
        _format_py_constants(constants),
        encoding="utf-8",
    )
    (PY_GENERATED_DIR / "_generated_errors.py").write_text(
        _format_py_errors(errors),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
