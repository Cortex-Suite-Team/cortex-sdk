// Generated from shared/constants.json. Do not edit manually.
export const DEFAULT_AUTH_URL = "https://cortexsuite.app";
export const AUTH_TOKEN_PATH = "/auth/token";
export const AUTH_REFRESH_PATH = "/auth/refresh";
export const WS_SUBPROTOCOL = "cortex-sdk.v1";
export const WS_SUBPROTOCOL_JWT_PREFIX = "cortex-sdk.jwt.";
export const SCHEMA_VERSION = "1.0";

export const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
export const DEFAULT_SESSION_OPEN_TIMEOUT_MS = 10000;
export const DEFAULT_SEND_TIMEOUT_MS = 10000;
export const DEFAULT_RESYNC_TIMEOUT_MS = 15000;
export const DEFAULT_PING_INTERVAL_MS = 15000;
export const DEFAULT_PONG_TIMEOUT_MS = 5000;
export const DEFAULT_STALE_THRESHOLD_MS = 45000;
export const TOKEN_REFRESH_BUFFER_MS = 60000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

/** @deprecated Use DEFAULT_AUTH_URL + AUTH_TOKEN_PATH instead. Scheduled for removal. */
export const CORTEX_AUTH_URL = `${DEFAULT_AUTH_URL}${AUTH_TOKEN_PATH}`;
/** @deprecated Use DEFAULT_AUTH_URL + AUTH_REFRESH_PATH instead. Scheduled for removal. */
export const CORTEX_REFRESH_URL = `${DEFAULT_AUTH_URL}${AUTH_REFRESH_PATH}`;
/** @deprecated Use WS_SUBPROTOCOL instead. Scheduled for removal. */
export const WS_SUBPROTOCOL_BASE = WS_SUBPROTOCOL;

export const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000] as const;
