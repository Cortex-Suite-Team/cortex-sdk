/**
 * Shared factory to reduce boilerplate across test files.
 */
import { WebSocket } from 'ws';
import { CortexClient } from '../src/client.js';
import type { CortexClientOptions, CortexMessage } from '../src/types.js';
import type { CortexClientPlatform } from '../src/client.js';
import type { MockServer } from './mock-server.js';
import { makeFetch } from './helpers.js';

export function makeClient(
  server: MockServer,
  onMessage: (msg: CortexMessage) => void,
  overrides: Partial<CortexClientOptions> = {},
): CortexClient {
  const platform: CortexClientPlatform = {
    WS: WebSocket as unknown as CortexClientPlatform['WS'],
    fetchFn: makeFetch(server.httpUrl),
  };

  return new CortexClient(
    {
      apiKey: 'test-key',
      authUrl: server.httpUrl,
      onMessage,
      connectTimeout: 2000,
      pingInterval: 60000,
      pongTimeout: 1000,
      staleThreshold: 60000,
      resyncTimeout: 2000,
      ...overrides,
    },
    platform,
  );
}
