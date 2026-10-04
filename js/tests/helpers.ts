/**
 * Test helpers — creates a CortexClient wired to a mock server.
 */
import { WebSocket } from 'ws';
import { CortexClient } from '../src/client.js';
import type { CortexClientOptions, FetchFn, FormDataCtor } from '../src/types.js';
import type { CortexClientPlatform } from '../src/client.js';
import type { MockServer } from './mock-server.js';

export function makeFetch(baseUrl: string): FetchFn {
  return async (url, init) => {
    // Prepend baseUrl for relative auth or Control Plane paths.
    const fullUrl = url.startsWith('http') ? url : `${baseUrl}${url}`;
    const res = await fetch(fullUrl, init as globalThis.RequestInit);
    return {
      ok: res.ok,
      status: res.status,
      json: () => res.json() as Promise<unknown>,
      arrayBuffer: () => res.arrayBuffer(),
      blob: () => res.blob(),
    };
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NodeFormData: FormDataCtor = (globalThis as any).FormData;

export function makeTestClient(
  server: MockServer,
  overrides: Partial<CortexClientOptions> = {},
): CortexClient {
  return new CortexClient(
    {
      apiKey: 'test-key',
      authUrl: server.httpUrl,
      onMessage: () => {},
      connectTimeout: 2000,
      pingInterval: 60000, // disable auto-ping in most tests
      pongTimeout: 1000,
      staleThreshold: 60000,
      ...overrides,
    },
    {
      WS: WebSocket as unknown as CortexClientPlatform['WS'],
      fetchFn: makeFetch(server.httpUrl),
    },
  );
}

export function waitFor(
  condition: () => boolean,
  timeoutMs = 3000,
  intervalMs = 20,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const id = setInterval(() => {
      if (condition()) {
        clearInterval(id);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(id);
        reject(new Error('waitFor timed out'));
      }
    }, intervalMs);
  });
}

export function collectMessages(client: CortexClient): {
  messages: Array<{ type: string; payload: Record<string, unknown> }>;
  onMessage: (msg: { type: string; payload: Record<string, unknown> }) => void;
} {
  const messages: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const onMessage = (msg: { type: string; payload: Record<string, unknown> }) => {
    messages.push(msg);
  };
  return { messages, onMessage };
}
