import { lookupError, makeError } from '../src/errors.js';
import { startMockServer } from './mock-server.js';
import { makeClient } from './test-client-factory.js';
import { waitFor } from './helpers.js';
import type { CortexMessage } from '../src/types.js';

function makeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.fakesig`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function receivedCodes(messages: CortexMessage[]): string[] {
  return messages
    .filter((message) => message.type === 'system::error')
    .map((message) => String(message.payload['code']));
}

describe('error_coverage', () => {
  it('covers auth_invalid', async () => {
    const meta = lookupError('auth_invalid')!;
    expect(meta.retryable).toBe(false);
    expect(meta.fatal).toBe(true);

    const server = await startMockServer({ autoInitEcho: true });
    server.injectError('auth_invalid', { phase: 'ws_connect' });
    const received: CortexMessage[] = [];
    const client = makeClient(server, (message) => received.push(message));

    try {
      await expect(client.connect()).rejects.toMatchObject({
        code: 'auth_invalid',
        retryable: false,
        fatal: true,
      });
      await waitFor(() => client.channelState === 'CLOSED', 3000);
      await delay(200);
      expect(client.channelState).toBe('CLOSED');
      expect(server.wsConnectionCount).toBe(1);
      expect(receivedCodes(received)).toEqual([]);
    } finally {
      await client.disconnect();
      await server.close();
    }
  });

  it('covers auth_expired', async () => {
    const meta = lookupError('auth_expired')!;
    expect(meta.retryable).toBe(true);
    expect(meta.fatal).toBe(false);

    const expiringToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 30 });
    const refreshedToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const server = await startMockServer({
      autoInitEcho: true,
      autoChatAnswer: true,
      initialAccessToken: expiringToken,
      refreshedAccessToken: refreshedToken,
    });
    server.injectError('auth_expired', {
      onMessageType: 'chat::message',
      closeAfterSend: true,
      closeCode: 1011,
      closeReason: 'auth_expired',
    });
    const received: CortexMessage[] = [];
    const client = makeClient(server, (message) => received.push(message), {
      pingInterval: 60000,
      staleThreshold: 60000,
    });

    try {
      await client.connect();
      await waitFor(() => client.sessionId !== null);
      await client.sendMessage({ content: 'trigger auth_expired' });
      await waitFor(() => receivedCodes(received).includes('auth_expired'), 3000);
      await waitFor(() => server.refreshCallCount >= 1, 5000);
      await waitFor(() => server.wsConnectionCount >= 2, 5000);
      await waitFor(() => client.channelState === 'OPEN', 5000);
      await client.sendMessage({ content: 'after refresh' });
      await waitFor(() => received.some((message) => message.type === 'chat::answer' && message.payload['answer_kind'] === 'final'), 3000);
      expect(receivedCodes(received)).toContain('auth_expired');
    } finally {
      await client.disconnect();
      await server.close();
    }
  });

  it('covers auth_refresh_failed', async () => {
    const meta = lookupError('auth_refresh_failed')!;
    expect(meta.retryable).toBe(false);
    expect(meta.fatal).toBe(true);

    const expiringToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 30 });
    const server = await startMockServer({
      autoInitEcho: true,
      initialAccessToken: expiringToken,
    });
    server.injectError('auth_refresh_failed', { phase: 'auth_refresh' });
    const received: CortexMessage[] = [];
    const client = makeClient(server, (message) => received.push(message), {
      pingInterval: 60000,
      staleThreshold: 60000,
    });

    try {
      await client.connect();
      await waitFor(() => client.sessionId !== null);
      server.dropConnections();
      await waitFor(() => client.channelState === 'AUTH_FAILED', 5000);
      expect(server.refreshCallCount).toBeGreaterThanOrEqual(1);
      expect(server.wsConnectionCount).toBe(1);
      expect(receivedCodes(received)).toEqual([]);
    } finally {
      await client.disconnect();
      await server.close();
    }
  });

  it('covers transport_connect_timeout', async () => {
    const meta = lookupError('transport_connect_timeout')!;
    expect(meta.retryable).toBe(true);
    expect(meta.fatal).toBe(false);

    const server = await startMockServer();
    server.injectError('transport_connect_timeout', { phase: 'auth_token' });
    const client = makeClient(server, () => {}, { connectTimeout: 100 });

    try {
      await expect(client.connect()).rejects.toMatchObject({
        code: 'transport_connect_timeout',
        retryable: true,
        fatal: false,
      });
      expect(server.wsConnectionCount).toBe(0);
    } finally {
      await client.disconnect();
      await server.close();
    }
  });

  it('covers transport_send_timeout', async () => {
    const meta = lookupError('transport_send_timeout')!;
    expect(meta.retryable).toBe(true);
    expect(meta.fatal).toBe(false);

    const server = await startMockServer({ autoInitEcho: true });
    const received: CortexMessage[] = [];
    const client = makeClient(server, (message) => received.push(message));

    try {
      await client.connect();
      await waitFor(() => client.sessionId !== null);
      const transport = (client as unknown as { _transport: { sendJson: (message: unknown, timeoutMs: number) => Promise<void> } })._transport;
      const originalSend = transport.sendJson.bind(transport);
      transport.sendJson = () => Promise.reject(makeError('transport_send_timeout', 'Injected send timeout'));
      await expect(client.sendMessage({ content: 'timeout' })).rejects.toMatchObject({
        code: 'transport_send_timeout',
        retryable: true,
        fatal: false,
      });
      transport.sendJson = originalSend;
    } finally {
      await client.disconnect();
      await server.close();
    }
  });

  it('covers transport_protocol_violation', async () => {
    const meta = lookupError('transport_protocol_violation')!;
    expect(meta.retryable).toBe(false);
    expect(meta.fatal).toBe(true);

    const server = await startMockServer({ autoInitEcho: true });
    server.injectError('transport_protocol_violation', { onMessageType: 'chat::message' });
    const received: CortexMessage[] = [];
    const client = makeClient(server, (message) => received.push(message));

    try {
      await client.connect();
      await waitFor(() => client.sessionId !== null);
      await client.sendMessage({ content: 'bad protocol' });
      await waitFor(() => receivedCodes(received).includes('transport_protocol_violation'), 3000);
      await waitFor(() => client.channelState === 'AUTH_FAILED', 3000);
      expect(server.wsConnectionCount).toBe(1);
    } finally {
      await client.disconnect();
      await server.close();
    }
  });

  it('covers unknown_session', async () => {
    const meta = lookupError('unknown_session')!;
    expect(meta.retryable).toBe(false);
    expect(meta.fatal).toBe(true);

    const server = await startMockServer({ autoInitEcho: true });
    server.injectError('unknown_session', {
      phase: 'resync',
      closeAfterSend: true,
      closeCode: 1011,
    });
    const received: CortexMessage[] = [];
    const client = makeClient(server, (message) => received.push(message), {
      pingInterval: 60000,
      staleThreshold: 60000,
    });

    try {
      await client.connect();
      await waitFor(() => client.sessionId !== null);
      server.dropConnections();
      await waitFor(() => receivedCodes(received).includes('unknown_session'), 5000);
      await waitFor(() => client.channelState === 'AUTH_FAILED', 5000);
      expect(server.wsConnectionCount).toBeGreaterThanOrEqual(2);
    } finally {
      await client.disconnect();
      await server.close();
    }
  });

  it('covers session_terminal', async () => {
    const meta = lookupError('session_terminal')!;
    expect(meta.retryable).toBe(false);
    expect(meta.fatal).toBe(true);

    const server = await startMockServer({ autoInitEcho: true });
    server.injectError('session_terminal', { onMessageType: 'chat::message' });
    const received: CortexMessage[] = [];
    const client = makeClient(server, (message) => received.push(message));

    try {
      await client.connect();
      await waitFor(() => client.sessionId !== null);
      await client.sendMessage({ content: 'terminal' });
      await waitFor(() => receivedCodes(received).includes('session_terminal'), 3000);
      await waitFor(() => client.sessionState === 'FAILED', 3000);
      expect(client.channelState).toBe('AUTH_FAILED');
    } finally {
      await client.disconnect();
      await server.close();
    }
  });

  it('covers resync_timeout', async () => {
    const meta = lookupError('resync_timeout')!;
    expect(meta.retryable).toBe(true);
    expect(meta.fatal).toBe(false);

    const server = await startMockServer({ autoInitEcho: true });
    const client = makeClient(server, () => {}, {
      pingInterval: 60000,
      staleThreshold: 60000,
      resyncTimeout: 100,
    });

    try {
      await client.connect();
      await waitFor(() => client.sessionId !== null);
      const session = (client as unknown as { _session: { sendResync: () => Promise<void> } })._session;
      const originalSendResync = session.sendResync.bind(session);
      session.sendResync = () => new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      server.dropConnections();
      await waitFor(() => server.wsConnectionCount >= 3, 5000);
      session.sendResync = originalSendResync;
    } finally {
      await client.disconnect();
      await server.close();
    }
  });

  it('covers replay_unavailable', async () => {
    const meta = lookupError('replay_unavailable')!;
    expect(meta.retryable).toBe(true);
    expect(meta.fatal).toBe(false);

    const server = await startMockServer({ autoInitEcho: true });
    server.injectError('replay_unavailable', {
      phase: 'resync',
      closeAfterSend: true,
      closeCode: 1011,
    });
    const received: CortexMessage[] = [];
    const client = makeClient(server, (message) => received.push(message), {
      pingInterval: 60000,
      staleThreshold: 60000,
    });

    try {
      await client.connect();
      await waitFor(() => client.sessionId !== null);
      server.dropConnections();
      await waitFor(() => receivedCodes(received).includes('replay_unavailable'), 5000);
      await waitFor(() => server.wsConnectionCount >= 3, 5000);
      await waitFor(() => client.channelState === 'OPEN', 5000);
    } finally {
      await client.disconnect();
      await server.close();
    }
  });

  it('covers file_upload_failed', async () => {
    const meta = lookupError('file_upload_failed')!;
    expect(meta.retryable).toBe(true);
    expect(meta.fatal).toBe(false);

    const server = await startMockServer({ autoInitEcho: true });
    server.injectError('file_upload_failed', { onMessageType: 'file::upload.prepare' });
    const client = makeClient(server, () => {});

    try {
      await client.connect();
      await waitFor(() => client.sessionId !== null);
      await expect(client.uploadAttachment(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
        code: 'file_upload_failed',
        retryable: true,
        fatal: false,
      });
      expect(server.uploadCallCount).toBe(0);
    } finally {
      await client.disconnect();
      await server.close();
    }
  });

  it('covers file_too_large', async () => {
    const meta = lookupError('file_too_large')!;
    expect(meta.retryable).toBe(false);
    expect(meta.fatal).toBe(false);

    const server = await startMockServer({ autoInitEcho: true });
    server.injectError('file_too_large', { onMessageType: 'file::upload.prepare' });
    const client = makeClient(server, () => {});

    try {
      await client.connect();
      await waitFor(() => client.sessionId !== null);
      await expect(client.uploadAttachment(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
        code: 'file_too_large',
        retryable: false,
        fatal: false,
      });
      expect(server.uploadCallCount).toBe(0);
    } finally {
      await client.disconnect();
      await server.close();
    }
  });

  it('covers file_type_rejected', async () => {
    const meta = lookupError('file_type_rejected')!;
    expect(meta.retryable).toBe(false);
    expect(meta.fatal).toBe(false);

    const server = await startMockServer({ autoInitEcho: true });
    server.injectError('file_type_rejected', { onMessageType: 'file::upload.prepare' });
    const client = makeClient(server, () => {});

    try {
      await client.connect();
      await waitFor(() => client.sessionId !== null);
      await expect(client.uploadAttachment(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
        code: 'file_type_rejected',
        retryable: false,
        fatal: false,
      });
      expect(server.uploadCallCount).toBe(0);
    } finally {
      await client.disconnect();
      await server.close();
    }
  });
});
