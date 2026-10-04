from __future__ import annotations

from dataclasses import dataclass

# Generated from sdk/shared/errors.json. Do not edit manually.

@dataclass(frozen=True)
class GeneratedErrorEntry:
    code: str
    retryable: bool
    fatal: bool

GENERATED_ERROR_CATALOG: tuple[GeneratedErrorEntry, ...] = (
    GeneratedErrorEntry('auth_invalid', retryable=False, fatal=True),
    GeneratedErrorEntry('auth_expired', retryable=True, fatal=False),
    GeneratedErrorEntry('auth_refresh_failed', retryable=False, fatal=True),
    GeneratedErrorEntry('transport_connect_timeout', retryable=True, fatal=False),
    GeneratedErrorEntry('transport_send_timeout', retryable=True, fatal=False),
    GeneratedErrorEntry('transport_protocol_violation', retryable=False, fatal=True),
    GeneratedErrorEntry('unknown_session', retryable=False, fatal=True),
    GeneratedErrorEntry('session_open_timeout', retryable=True, fatal=False),
    GeneratedErrorEntry('session_terminal', retryable=False, fatal=True),
    GeneratedErrorEntry('resync_timeout', retryable=True, fatal=False),
    GeneratedErrorEntry('replay_unavailable', retryable=True, fatal=False),
    GeneratedErrorEntry('session_not_ready', retryable=True, fatal=False),
    GeneratedErrorEntry('file_api_unavailable', retryable=False, fatal=False),
    GeneratedErrorEntry('file_not_found', retryable=False, fatal=False),
    GeneratedErrorEntry('file_access_denied', retryable=False, fatal=False),
    GeneratedErrorEntry('file_expired', retryable=False, fatal=False),
    GeneratedErrorEntry('file_operation_failed', retryable=True, fatal=False),
    GeneratedErrorEntry('file_transport_unavailable', retryable=True, fatal=False),
    GeneratedErrorEntry('file_too_large', retryable=False, fatal=False),
    GeneratedErrorEntry('file_type_rejected', retryable=False, fatal=False),
    GeneratedErrorEntry('invalid_file_transfer', retryable=False, fatal=False),
    GeneratedErrorEntry('file_transfer_interrupted', retryable=True, fatal=False),
    GeneratedErrorEntry('file_upload_failed', retryable=True, fatal=False),
    GeneratedErrorEntry('file_download_failed', retryable=True, fatal=False),
    GeneratedErrorEntry('file_unavailable', retryable=True, fatal=False),
)
