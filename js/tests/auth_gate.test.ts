/**
 * Slice 10: auth-required flow tests.
 *
 * Covers:
 * - exchangeApiKey parses both NormalAuthTokenResponse and AuthRequiredTokenResponse
 * - connect() in auth-required path: WS opens, system::init NOT sent, resolves immediately
 * - system::auth before system::opened does not trigger transport_protocol_violation
 * - system::opened after login sets session context
 * - sendLogin sends system::login (not chat::message)
 * - sendMessage (chat::message) still works normally after session opens
 */
import { startMockServer, FIXED_SESSION_ID } from './mock-server.js';
import { makeClient } from './test-client-factory.js';
import { waitFor } from './helpers.js';
import { exchangeApiKey } from '../src/auth.js';
import type { CortexMessage, AuthRequiredTokenResponse, NormalAuthTokenResponse } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOpenedEnvelope(sessionId: string = FIXED_SESSION_ID): Record<string, unknown> {
  return {
    type: 'system::opened',
    schema: '1.0',
    session_id: sessionId,
    seq: 1,
    payload: {
      status: 'initializing',
      execution_mode: 'production',
      artifact_id: 'rel_42',
      artifact_kind: 'graph',
      run_mode: 'normal',
      identity: {
        tenant_id: 'tenant_test',
        project_id: 'project_test',
        deployment_id: 'deploy_test',
        release_id: 'rel_42',
        user_id: 'user_1',
        user_uuid: 'uuid-user-1',
        actor_kind: 'user',
        actor_ref: 'user:1',
      },
      correspondent: {
        kind: 'digital_worker',
        id: 'project_test',
        name: 'Mock Worker',
        title: 'Digital Worker',
        subtitle: null,
        avatar_url: null,
      },
    },
    ts: new Date().toISOString(),
  };
}

function makeAuthFrame(state: 'required' | 'denied' | 'accepted'): Record<string, unknown> {
  return {
    type: 'system::auth',
    schema: '1.0',
    payload: { state, method: 'login_password', message: `Auth ${state}` },
    ts: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Unit tests: exchangeApiKey response parsing
// ---------------------------------------------------------------------------

describe('exchangeApiKey response parsing', () => {
  it('returns NormalAuthTokenResponse when auth_required is absent', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          ws_url: 'ws://localhost/ws',
          access_token: 'at',
          refresh_token: 'rt',
          runtime_bootstrap: {
            execution_mode: 'production',
            bundle_url: '/bundle',
            checksum: 'sha256:abc',
          },
        };
      },
    });

    const response = await exchangeApiKey('key', mockFetch as never, 'http://localhost');
    expect(response.auth_required).toBeFalsy();
    expect((response as NormalAuthTokenResponse).runtime_bootstrap).toBeDefined();
    expect((response as NormalAuthTokenResponse).runtime_bootstrap.execution_mode).toBe('production');
  });

  it('returns AuthRequiredTokenResponse when auth_required is true', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          auth_required: true,
          ws_url: 'ws://localhost/ws',
          access_token: 'at',
          refresh_token: 'rt',
          auth: {
            type: 'system::auth',
            payload: { state: 'required', method: 'login_password' },
          },
        };
      },
    });

    const response = await exchangeApiKey('key', mockFetch as never, 'http://localhost');
    expect(response.auth_required).toBe(true);
    const authResponse = response as AuthRequiredTokenResponse;
    expect(authResponse.auth?.type).toBe('system::auth');
    expect((authResponse as { runtime_bootstrap?: unknown }).runtime_bootstrap).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration tests: connect() in auth-required path
// ---------------------------------------------------------------------------

describe('connect() auth-required path', () => {
  it('resolves without system::opened and without sending system::init', async () => {
    const server = await startMockServer({ authRequired: true, autoInitEcho: false });
    const received: CortexMessage[] = [];
    const client = makeClient(server, (msg) => received.push(msg));

    try {
      // connect() must resolve without a system::opened from the server
      await client.connect();

      // WS should be open
      expect(client.channelState).toBe('OPEN');

      // system::init must NOT have been sent
      const initFrames = server.received.filter((f) => f['type'] === 'system::init');
      expect(initFrames).toHaveLength(0);

      // session is not yet established
      expect(client.sessionId).toBeNull();
      expect(client.sessionContext).toBeNull();
    } finally {
      await client.disconnect();
      await server.close();
    }
  });

  it('system::auth before system::opened does not trigger transport_protocol_violation', async () => {
    const server = await startMockServer({ authRequired: true, autoInitEcho: false });
    const client = makeClient(server, () => {});

    try {
      await client.connect();

      // Wait for the WS client to appear in server.clients
      await waitFor(() => server.clients.size > 0);
      const [connectedWs] = server.clients;

      // server sends system::auth state=required — should be dispatched, not cause fatal error
      server.sendTo(connectedWs, makeAuthFrame('required'));

      // give it a tick to process
      await new Promise((r) => setTimeout(r, 30));

      // channel must still be open (no fatal error closed it)
      expect(client.channelState).toBe('OPEN');
    } finally {
      await client.disconnect();
      await server.close();
    }
  });

  it('system::auth is dispatched to onMessage handlers', async () => {
    const received: CortexMessage[] = [];

    const server = await startMockServer({ authRequired: true, autoInitEcho: false });
    const client = makeClient(server, (msg) => received.push(msg));

    try {
      await client.connect();
      await waitFor(() => server.clients.size > 0);
      const [connectedWs] = server.clients;

      server.sendTo(connectedWs, makeAuthFrame('required'));
      await waitFor(() => received.some((m) => m.type === 'system::auth'));

      const authMsg = received.find((m) => m.type === 'system::auth')!;
      expect(authMsg.payload['state']).toBe('required');
    } finally {
      await client.disconnect();
      await server.close();
    }
  });

  it('system::opened after login sets sessionId and sessionContext', async () => {
    const received: CortexMessage[] = [];
    let connectedWs: import('ws').WebSocket | null = null;

    const server = await startMockServer({
      authRequired: true,
      autoInitEcho: false,
      onWsMessage: (parsed, ws) => {
        connectedWs = ws;
        if (parsed['type'] === 'system::login') {
          // simulate successful login: send accepted then opened
          server.sendTo(ws, makeAuthFrame('accepted'));
          server.sendTo(ws, makeOpenedEnvelope());
        }
      },
    });
    const client = makeClient(server, (msg) => received.push(msg));

    try {
      await client.connect();

      // send login
      await client.sendLogin({ login: 'alice', password: 's3cr3t' });

      // wait for system::opened to be processed
      await waitFor(() => client.sessionId !== null);

      expect(client.sessionId).toBe(FIXED_SESSION_ID);
      expect(client.sessionContext?.sessionId).toBe(FIXED_SESSION_ID);
      expect(client.sessionContext?.identity?.userId).toBe('user_1');

      // accepted and opened should both be dispatched
      expect(received.some((m) => m.type === 'system::auth' && m.payload['state'] === 'accepted')).toBe(true);
      expect(received.some((m) => m.type === 'system::opened')).toBe(true);
    } finally {
      await client.disconnect();
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// sendLogin / sendChatMessage routing
// ---------------------------------------------------------------------------

describe('sendLogin sends system::login', () => {
  it('produces system::login envelope with login and password', async () => {
    let connectedWs: import('ws').WebSocket | null = null;

    const server = await startMockServer({
      authRequired: true,
      autoInitEcho: false,
      onWsMessage: (_parsed, ws) => { connectedWs = ws; },
    });
    const client = makeClient(server, () => {});

    try {
      await client.connect();
      await client.sendLogin({ login: 'alice@example.com', password: 'hunter2' });

      await waitFor(() => server.received.some((f) => f['type'] === 'system::login'));

      const loginFrame = server.received.find((f) => f['type'] === 'system::login')!;
      expect(loginFrame['type']).toBe('system::login');
      const payload = loginFrame['payload'] as Record<string, unknown>;
      expect(payload['login']).toBe('alice@example.com');
      expect(payload['password']).toBe('hunter2');
      // must NOT have a session_id (pre-session)
      expect(loginFrame['session_id']).toBeUndefined();
    } finally {
      await client.disconnect();
      await server.close();
    }
  });

  it('sendLogin does NOT produce chat::message', async () => {
    const server = await startMockServer({
      authRequired: true,
      autoInitEcho: false,
    });
    const client = makeClient(server, () => {});

    try {
      await client.connect();
      await client.sendLogin({ login: 'alice', password: 'pw' });

      await waitFor(() => server.received.some((f) => f['type'] === 'system::login'));

      const chatFrames = server.received.filter((f) => f['type'] === 'chat::message');
      expect(chatFrames).toHaveLength(0);
    } finally {
      await client.disconnect();
      await server.close();
    }
  });

  it('sendMessage (chat::message) still works after session opens post-login', async () => {
    const server = await startMockServer({
      authRequired: true,
      autoInitEcho: false,
      autoChatAnswer: false,
      onWsMessage: (parsed, ws) => {
        if (parsed['type'] === 'system::login') {
          server.sendTo(ws, makeOpenedEnvelope());
        }
      },
    });
    const client = makeClient(server, () => {});

    try {
      await client.connect();
      await client.sendLogin({ login: 'alice', password: 'pw' });
      await waitFor(() => client.sessionId !== null);

      await client.sendMessage({ content: 'Hello after login' });

      await waitFor(() => server.received.some((f) => f['type'] === 'chat::message'));

      const chatFrame = server.received.find((f) => f['type'] === 'chat::message')!;
      expect((chatFrame['payload'] as Record<string, unknown>)['content']).toEqual(['Hello after login']);
      expect(chatFrame['session_id']).toBe(FIXED_SESSION_ID);
    } finally {
      await client.disconnect();
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Public path unaffected
// ---------------------------------------------------------------------------

describe('public path is unaffected by auth-required changes', () => {
  it('connect() still sends system::init and waits for system::opened', async () => {
    const server = await startMockServer({ autoInitEcho: true });
    const client = makeClient(server, () => {});

    try {
      await client.connect();

      expect(client.channelState).toBe('OPEN');
      expect(client.sessionId).toBe(FIXED_SESSION_ID);

      const initFrames = server.received.filter((f) => f['type'] === 'system::init');
      expect(initFrames).toHaveLength(1);
    } finally {
      await client.disconnect();
      await server.close();
    }
  });
});
