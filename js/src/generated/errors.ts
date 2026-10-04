// Generated from sdk/shared/errors.json. Do not edit manually.
export interface GeneratedErrorEntry {
  readonly code: string;
  readonly retryable: boolean;
  readonly fatal: boolean;
}

export const GENERATED_ERROR_CATALOG: readonly GeneratedErrorEntry[] = [
  { code: 'auth_invalid', retryable: false, fatal: true },
  { code: 'auth_expired', retryable: true, fatal: false },
  { code: 'auth_refresh_failed', retryable: false, fatal: true },
  { code: 'transport_connect_timeout', retryable: true, fatal: false },
  { code: 'transport_send_timeout', retryable: true, fatal: false },
  { code: 'transport_protocol_violation', retryable: false, fatal: true },
  { code: 'unknown_session', retryable: false, fatal: true },
  { code: 'session_open_timeout', retryable: true, fatal: false },
  { code: 'session_terminal', retryable: false, fatal: true },
  { code: 'resync_timeout', retryable: true, fatal: false },
  { code: 'replay_unavailable', retryable: true, fatal: false },
  { code: 'session_not_ready', retryable: true, fatal: false },
  { code: 'file_api_unavailable', retryable: false, fatal: false },
  { code: 'file_not_found', retryable: false, fatal: false },
  { code: 'file_access_denied', retryable: false, fatal: false },
  { code: 'file_expired', retryable: false, fatal: false },
  { code: 'file_operation_failed', retryable: true, fatal: false },
  { code: 'file_transport_unavailable', retryable: true, fatal: false },
  { code: 'file_too_large', retryable: false, fatal: false },
  { code: 'file_type_rejected', retryable: false, fatal: false },
  { code: 'invalid_file_transfer', retryable: false, fatal: false },
  { code: 'file_transfer_interrupted', retryable: true, fatal: false },
  { code: 'file_upload_failed', retryable: true, fatal: false },
  { code: 'file_download_failed', retryable: true, fatal: false },
  { code: 'file_unavailable', retryable: true, fatal: false },
];
