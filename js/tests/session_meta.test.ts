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
    const parsed = JSON.parse(data) as { type?: string; payload?: Record<string, unknown>; meta?: Record<string, unknown> };
    if (parsed.type === 'system::init') {
      const payload = parsed.payload ?? {};
      const sessionContext = (payload['session_context'] as Record<string, unknown> | undefined) ?? {};
      setTimeout(() => {
        this.onmessage?.({
          data: JSON.stringify({
            type: 'system::opened',
            schema: '1.0',
            session_id: 'sess_test',
            payload: {
              status: 'initializing',
              client_msg_id: typeof parsed.meta?.['client_msg_id'] === 'string' ? parsed.meta['client_msg_id'] : 'cli_init_test',
              execution_mode: payload['execution_mode'] ?? 'production',
              artifact_id: payload['artifact_id'] ?? null,
              artifact_kind: payload['artifact_kind'] ?? null,
              run_mode: payload['run_mode'] ?? null,
              identity: sessionContext['identity'] ?? null,
              correspondent: sessionContext['correspondent'] ?? null,
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

describe('sessionMeta retention', () => {
  it('retains bootstrap trigger meta for compatibility, forwards unchanged runtime_bootstrap, and exposes sessionContext', async () => {
    const runtimeBootstrap = {
      execution_mode: 'production',
      bundle_url: '/bundle',
      checksum: 'sha256:test',
      session_context: {
        identity: {
          tenant_id: 'tenant_123',
          project_id: '123',
          deployment_id: 'deploy_123',
          release_id: 'release_123',
          user_id: null,
          user_uuid: null,
          actor_kind: 'public_widget_user',
          actor_ref: 'public_widget:tenant_123:123:live-worker',
        },
        correspondent: {
          kind: 'digital_worker',
          id: 'project_123',
          name: 'Robot Vasya',
          title: 'Legal Assistant',
        },
      },
      trigger_payload: {
        meta: {
          project_id: '123',
          chat_correspondent: {
            kind: 'digital_worker',
            id: 'project_123',
            name: 'Robot Vasya',
            title: 'Legal Assistant',
          },
        },
      },
    };

    const fetchFn: FetchFn = async (_url, _init) => makeResponse({
      ws_url: 'ws://runtime.test/ws',
      access_token: makeJwt(3600),
      refresh_token: 'refresh_token_v1',
      runtime_bootstrap: runtimeBootstrap,
    });

    const client = new CortexClient(
      {
        apiKey: 'test-key',
        onMessage: () => {},
        pingInterval: 60000,
        staleThreshold: 60000,
      },
      makePlatform(fetchFn),
    );

    const sendInitCalls: unknown[] = [];
    const session = (client as unknown as { _session: { sendInit: (bootstrap: unknown) => Promise<void> } })._session;
    const originalSendInit = session.sendInit.bind(session);
    session.sendInit = async (bootstrap: unknown) => {
      sendInitCalls.push(bootstrap);
      await originalSendInit(bootstrap);
    };

    try {
      await client.connect();

      expect(sendInitCalls).toEqual([runtimeBootstrap]);
      expect(client.sessionContext).toEqual({
        sessionId: 'sess_test',
        status: 'initializing',
        executionMode: 'production',
        artifactId: null,
        artifactKind: null,
        runMode: null,
        identity: {
          tenantId: 'tenant_123',
          projectId: '123',
          deploymentId: 'deploy_123',
          releaseId: 'release_123',
          userId: null,
          userUuid: null,
          actorKind: 'public_widget_user',
          actorRef: 'public_widget:tenant_123:123:live-worker',
        },
        correspondent: {
          kind: 'digital_worker',
          id: 'project_123',
          name: 'Robot Vasya',
          title: 'Legal Assistant',
          subtitle: null,
          avatarUrl: null,
        },
      });
      expect(client.sessionMeta).toMatchObject(runtimeBootstrap.trigger_payload.meta);
      expect(client.sessionMeta?.['chat_correspondent']).toEqual({
        kind: 'digital_worker',
        id: 'project_123',
        name: 'Robot Vasya',
        title: 'Legal Assistant',
      });
    } finally {
      await client.disconnect();
    }
  });
});
