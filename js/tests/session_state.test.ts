import { jest } from '@jest/globals';

import { createSession } from '../src/session.js';
import type { Transport } from '../src/transport.js';
import type { RuntimeBootstrap, SessionState } from '../src/types.js';

function makeTransport(): Transport {
  return {
    open: jest.fn(async () => undefined),
    sendJson: jest.fn(async () => undefined),
    sendBinary: jest.fn(async () => undefined),
    close: jest.fn(),
    onText: null,
    onBinary: null,
    onClose: null,
    onError: null,
  };
}

const BOOTSTRAP: RuntimeBootstrap = {
  execution_mode: 'production',
  bundle_url: '/api/runtime/releases/42/bundle/',
  checksum: 'sha256:test',
};

function makeServerMessage(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    type,
    schema: '1.0',
    session_id: 'sess_123',
    payload,
    ts: '2026-04-04T00:00:00Z',
  });
}

function openSession(session: ReturnType<typeof createSession>) {
  session.handleIncoming(makeServerMessage('system::opened', {
    status: 'initializing',
    client_msg_id: 'cli_init_test',
    execution_mode: 'production',
  }));
}

describe('session state transitions', () => {
  it('transitions from INITIALIZING to ACTIVE on system::opened', async () => {
    const session = createSession({
      onMessage: jest.fn(),
      onFatalError: jest.fn(),
    });
    session.setTransport(makeTransport(), 1000);

    await session.sendInit(BOOTSTRAP);
    expect(session.sessionState).toBe('INITIALIZING');

    session.handleIncoming(makeServerMessage('system::opened', {
      status: 'initializing',
      client_msg_id: 'cli_init_test',
      execution_mode: 'production',
    }));

    expect(session.sessionId).toBe('sess_123');
    expect(session.sessionState).toBe('ACTIVE');
  });

  it.each<[string, Record<string, unknown>, SessionState]>([
    ['sandbox::snapshot', { state: 'waiting' }, 'WAITING'],
    ['sandbox::lifecycle', { status: 'active' }, 'ACTIVE'],
    ['sandbox::lifecycle', { status: 'completed' }, 'COMPLETED'],
    ['sandbox::lifecycle', { status: 'failed' }, 'FAILED'],
    ['sandbox::lifecycle', { status: 'stopped' }, 'STOPPED'],
    ['sandbox::lifecycle', { status: 'timeout' }, 'TIMEOUT'],
    ['sandbox::lifecycle', { status: 'cancelled' }, 'CANCELLED'],
  ])('maps %s payload to %s', async (type, payload, expectedState) => {
    const session = createSession({
      onMessage: jest.fn(),
      onFatalError: jest.fn(),
    });
    session.setTransport(makeTransport(), 1000);

    await session.sendInit(BOOTSTRAP);
    openSession(session);
    session.handleIncoming(makeServerMessage(type, payload));

    expect(session.sessionState).toBe(expectedState);
  });

  it('marks the session FAILED and raises fatal callback on terminal system::error', async () => {
    const onFatalError = jest.fn();
    const session = createSession({
      onMessage: jest.fn(),
      onFatalError,
    });
    session.setTransport(makeTransport(), 1000);

    await session.sendInit(BOOTSTRAP);
    openSession(session);
    session.handleIncoming(makeServerMessage('system::error', {
      code: 'session_terminal',
      message: 'Session ended',
    }));

    expect(session.sessionState).toBe('FAILED');
    expect(onFatalError).toHaveBeenCalledTimes(1);
  });
});
