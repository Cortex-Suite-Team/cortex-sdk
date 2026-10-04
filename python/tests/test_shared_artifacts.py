from __future__ import annotations

import json
from pathlib import Path

from cortex_sdk.constants import (
    DEFAULT_AUTH_URL,
    AUTH_TOKEN_PATH,
    AUTH_REFRESH_PATH,
    DEFAULT_CONNECT_TIMEOUT,
    DEFAULT_PING_INTERVAL,
    DEFAULT_PONG_TIMEOUT,
    DEFAULT_RESYNC_TIMEOUT,
    DEFAULT_SEND_TIMEOUT,
    DEFAULT_STALE_THRESHOLD,
    RECONNECT_BACKOFF,
    SCHEMA_VERSION,
    TOKEN_REFRESH_BUFFER,
    WS_SUBPROTOCOL,
    WS_SUBPROTOCOL_JWT_PREFIX,
)
from cortex_sdk.errors import lookup_error


ROOT = Path(__file__).resolve().parents[2]


def test_constants_match_shared_artifact() -> None:
    shared = json.loads((ROOT / "shared" / "constants.json").read_text(encoding="utf-8"))

    assert DEFAULT_AUTH_URL == shared["DEFAULT_AUTH_URL"]
    assert AUTH_TOKEN_PATH == shared["AUTH_TOKEN_PATH"]
    assert AUTH_REFRESH_PATH == shared["AUTH_REFRESH_PATH"]
    assert WS_SUBPROTOCOL == shared["WS_SUBPROTOCOL"]
    assert WS_SUBPROTOCOL_JWT_PREFIX == shared["WS_SUBPROTOCOL_JWT_PREFIX"]
    assert SCHEMA_VERSION == shared["SCHEMA_VERSION"]
    assert DEFAULT_CONNECT_TIMEOUT == shared["DEFAULT_CONNECT_TIMEOUT_MS"] / 1000
    assert DEFAULT_SEND_TIMEOUT == shared["DEFAULT_SEND_TIMEOUT_MS"] / 1000
    assert DEFAULT_RESYNC_TIMEOUT == shared["DEFAULT_RESYNC_TIMEOUT_MS"] / 1000
    assert DEFAULT_PING_INTERVAL == shared["DEFAULT_PING_INTERVAL_MS"] / 1000
    assert DEFAULT_PONG_TIMEOUT == shared["DEFAULT_PONG_TIMEOUT_MS"] / 1000
    assert DEFAULT_STALE_THRESHOLD == shared["DEFAULT_STALE_THRESHOLD_MS"] / 1000
    assert TOKEN_REFRESH_BUFFER == shared["TOKEN_REFRESH_BUFFER_MS"] / 1000
    assert RECONNECT_BACKOFF == [value / 1000 for value in shared["RECONNECT_BACKOFF_MS"]]


def test_errors_match_shared_artifact() -> None:
    shared = json.loads((ROOT / "shared" / "errors.json").read_text(encoding="utf-8"))

    assert len(shared["errors"]) == 25
    for entry in shared["errors"]:
        resolved = lookup_error(entry["code"])
        assert resolved is not None
        assert resolved.code == entry["code"]
        assert resolved.retryable == entry["retryable"]
        assert resolved.fatal == entry["fatal"]
