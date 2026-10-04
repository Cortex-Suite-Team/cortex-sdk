import {
  AUTH_REFRESH_PATH,
  AUTH_TOKEN_PATH,
  DEFAULT_AUTH_URL,
} from '../src/constants.js';
import { CortexClient, type CortexClientPlatform } from '../src/client.js';
import type { FetchFn, FormDataCtor, Response, WebSocketLike } from '../src/types.js';

class FakeWebSocket implements WebSocketLike {
  readyState = 1;
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string | Buffer }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: WebSocketLike['onmessage'] = null;

  constructor(_url: string, _protocols: string[]) {
    setTimeout(() => this.onopen?.({}), 0);
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (typeof data !== 'string') return;
    const parsed = JSON.parse(data) as { type?: string; meta?: Record<string, unknown> };
    if (parsed.type === 'system::init') {
      setTimeout(() => {
        this.onmessage?.({
          data: JSON.stringify({
            type: 'system::opened',
            schema: '1.0',
            session_id: 'sess_test',
            payload: {
              status: 'initializing',
              client_msg_id: typeof parsed.meta?.['client_msg_id'] === 'string' ? parsed.meta['client_msg_id'] : 'cli_init_test',
              execution_mode: 'production',
              identity: {
                tenant_id: 'tenant_test',
                project_id: 'project_test',
                deployment_id: null,
                release_id: 'release_test',
                user_id: null,
                user_uuid: null,
                actor_kind: 'tenant_api_key_user',
                actor_ref: 'tenant_project:tenant_test:project_test',
              },
              correspondent: {
                kind: 'digital_worker',
                id: 'project_test',
                name: 'Test Worker',
                title: 'Digital Worker',
                subtitle: null,
                avatar_url: null,
              },
            },
            meta: parsed.meta ?? {},
            ts: new Date().toISOString(),
          }),
        });
      }, 0);
    }
  }

  close(code = 1000, reason = 'disconnect'): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function makeResponse(body: Record<string, unknown>, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  };
}

function makeJwt(expSecondsFromNow: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }),
  ).toString('base64url');
  return `${header}.${payload}.fakesig`;
}

function makePlatform(fetchFn: FetchFn): CortexClientPlatform {
  return {
    WS: FakeWebSocket as unknown as CortexClientPlatform['WS'],
    fetchFn,
  };
}

describe('auth configuration', () => {
  it('uses the default auth URL when authUrl is not provided', async () => {
    const urls: string[] = [];
    const headers: Array<Record<string, string> | undefined> = [];
    const bodies: Array<string | FormData | Uint8Array | undefined> = [];
    const fetchFn: FetchFn = async (url, init) => {
      urls.push(url);
      headers.push(init.headers);
      bodies.push(init.body);
      return makeResponse({
        ws_url: 'ws://runtime.test/ws',
        access_token: makeJwt(3600),
        refresh_token: 'refresh_token_v1',
        runtime_bootstrap: {
          execution_mode: 'production',
          bundle_url: '/bundle',
          checksum: 'sha256:test',
        },
      });
    };

    const client = new CortexClient(
      {
        apiKey: 'test-key',
        onMessage: () => {},
        pingInterval: 60000,
        staleThreshold: 60000,
      },
      makePlatform(fetchFn),
    );

    try {
      await client.connect();
      expect(urls).toEqual([`${DEFAULT_AUTH_URL}${AUTH_TOKEN_PATH}`]);
      expect(headers[0]?.Authorization).toBe('ApiKey test-key');
      expect(bodies[0]).toBeUndefined();
    } finally {
      await client.disconnect();
    }
  });

  it('normalizes a full token endpoint URL to base URL', async () => {
    const urls: string[] = [];
    const fetchFn: FetchFn = async (url, _init) => {
      urls.push(url);
      return makeResponse({
        ws_url: 'ws://runtime.test/ws',
        access_token: makeJwt(3600),
        refresh_token: 'refresh_token_v1',
        runtime_bootstrap: {
          execution_mode: 'production',
          bundle_url: '/bundle',
          checksum: 'sha256:test',
        },
      });
    };

    const client = new CortexClient(
      {
        apiKey: 'test-key',
        authUrl: 'https://auth.example.test/auth/token', // wrong: full endpoint instead of base URL
        onMessage: () => {},
        pingInterval: 60000,
        staleThreshold: 60000,
      },
      makePlatform(fetchFn),
    );

    try {
      await client.connect();
      // Must NOT produce /auth/token/auth/token
      expect(urls).toEqual(['https://auth.example.test/auth/token']);
    } finally {
      await client.disconnect();
    }
  });

  it('uses the configured authUrl for token exchange and refresh', async () => {
    const urls: string[] = [];
    const headers: Array<Record<string, string> | undefined> = [];
    const bodies: Array<string | FormData | Uint8Array | undefined> = [];
    const fetchFn: FetchFn = async (url, init) => {
      urls.push(url);
      headers.push(init.headers);
      bodies.push(init.body);

      if (url.endsWith(AUTH_TOKEN_PATH)) {
        return makeResponse({
          ws_url: 'ws://runtime.test/ws',
          access_token: makeJwt(30),
          refresh_token: 'refresh_token_v1',
          runtime_bootstrap: {
            execution_mode: 'production',
            bundle_url: '/bundle',
            checksum: 'sha256:test',
          },
        });
      }

      return makeResponse({ access_token: makeJwt(3600) });
    };

    const client = new CortexClient(
      {
        apiKey: 'test-key',
        authUrl: 'https://auth.example.test/',
        onMessage: () => {},
        pingInterval: 60000,
        staleThreshold: 60000,
      },
      makePlatform(fetchFn),
    );

    try {
      await client.connect();
      await (client as unknown as { _maybeRefreshToken(): Promise<void> })._maybeRefreshToken();

      expect(urls).toEqual([
        'https://auth.example.test/auth/token',
        'https://auth.example.test/auth/refresh',
      ]);
      expect(headers[0]?.Authorization).toBe('ApiKey test-key');
      expect(headers[1]?.Authorization).toBe('Bearer refresh_token_v1');
      expect(bodies[0]).toBeUndefined();
    } finally {
      await client.disconnect();
    }
  });

  it('sends worker_ref in the auth exchange body when configured', async () => {
    const bodies: Array<string | FormData | Uint8Array | undefined> = [];
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(init.body);
      return makeResponse({
        ws_url: 'ws://runtime.test/ws',
        access_token: makeJwt(3600),
        refresh_token: 'refresh_token_v1',
        runtime_bootstrap: {
          execution_mode: 'production',
          bundle_url: '/bundle',
          checksum: 'sha256:test',
        },
      });
    };

    const client = new CortexClient(
      {
        apiKey: 'test-key',
        workerRef: 'live-worker',
        onMessage: () => {},
        pingInterval: 60000,
        staleThreshold: 60000,
      },
      makePlatform(fetchFn),
    );

    try {
      await client.connect();
      expect(bodies[0]).toBe(JSON.stringify({ worker_ref: 'live-worker' }));
    } finally {
      await client.disconnect();
    }
  });
});
