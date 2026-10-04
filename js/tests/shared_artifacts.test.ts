import { readFileSync } from 'node:fs';

import {
  DEFAULT_AUTH_URL,
  AUTH_TOKEN_PATH,
  AUTH_REFRESH_PATH,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_PING_INTERVAL_MS,
  DEFAULT_PONG_TIMEOUT_MS,
  DEFAULT_RESYNC_TIMEOUT_MS,
  DEFAULT_SEND_TIMEOUT_MS,
  DEFAULT_STALE_THRESHOLD_MS,
  RECONNECT_BACKOFF_MS,
  SCHEMA_VERSION,
  TOKEN_REFRESH_BUFFER_MS,
  WS_SUBPROTOCOL,
  WS_SUBPROTOCOL_JWT_PREFIX,
} from '../src/constants.js';
import { lookupError } from '../src/errors.js';

describe('shared artifact parity', () => {
  it('matches sdk/shared/constants.json', () => {
    const shared = JSON.parse(
      readFileSync(new URL('../../shared/constants.json', import.meta.url), 'utf-8'),
    ) as {
      DEFAULT_AUTH_URL: string;
      AUTH_TOKEN_PATH: string;
      AUTH_REFRESH_PATH: string;
      WS_SUBPROTOCOL: string;
      WS_SUBPROTOCOL_JWT_PREFIX: string;
      SCHEMA_VERSION: string;
      DEFAULT_CONNECT_TIMEOUT_MS: number;
      DEFAULT_SEND_TIMEOUT_MS: number;
      DEFAULT_RESYNC_TIMEOUT_MS: number;
      DEFAULT_PING_INTERVAL_MS: number;
      DEFAULT_PONG_TIMEOUT_MS: number;
      DEFAULT_STALE_THRESHOLD_MS: number;
      TOKEN_REFRESH_BUFFER_MS: number;
      RECONNECT_BACKOFF_MS: number[];
    };

    expect(DEFAULT_AUTH_URL).toBe(shared.DEFAULT_AUTH_URL);
    expect(AUTH_TOKEN_PATH).toBe(shared.AUTH_TOKEN_PATH);
    expect(AUTH_REFRESH_PATH).toBe(shared.AUTH_REFRESH_PATH);
    expect(WS_SUBPROTOCOL).toBe(shared.WS_SUBPROTOCOL);
    expect(WS_SUBPROTOCOL_JWT_PREFIX).toBe(shared.WS_SUBPROTOCOL_JWT_PREFIX);
    expect(SCHEMA_VERSION).toBe(shared.SCHEMA_VERSION);
    expect(DEFAULT_CONNECT_TIMEOUT_MS).toBe(shared.DEFAULT_CONNECT_TIMEOUT_MS);
    expect(DEFAULT_SEND_TIMEOUT_MS).toBe(shared.DEFAULT_SEND_TIMEOUT_MS);
    expect(DEFAULT_RESYNC_TIMEOUT_MS).toBe(shared.DEFAULT_RESYNC_TIMEOUT_MS);
    expect(DEFAULT_PING_INTERVAL_MS).toBe(shared.DEFAULT_PING_INTERVAL_MS);
    expect(DEFAULT_PONG_TIMEOUT_MS).toBe(shared.DEFAULT_PONG_TIMEOUT_MS);
    expect(DEFAULT_STALE_THRESHOLD_MS).toBe(shared.DEFAULT_STALE_THRESHOLD_MS);
    expect(TOKEN_REFRESH_BUFFER_MS).toBe(shared.TOKEN_REFRESH_BUFFER_MS);
    expect(Array.from(RECONNECT_BACKOFF_MS)).toEqual(shared.RECONNECT_BACKOFF_MS);
  });

  it('matches sdk/shared/errors.json', () => {
    const shared = JSON.parse(
      readFileSync(new URL('../../shared/errors.json', import.meta.url), 'utf-8'),
    ) as {
      errors: Array<{ code: string; retryable: boolean; fatal: boolean }>;
    };

    expect(shared.errors).toHaveLength(25);
    for (const entry of shared.errors) {
      expect(lookupError(entry.code)).toEqual({
        code: entry.code,
        retryable: entry.retryable,
        fatal: entry.fatal,
      });
    }
  });
});
