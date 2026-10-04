/**
 * Slice 3: CortexClient.accessToken and CortexClient.cpApiUrl getters.
 * These expose the current session credentials for use by the widget's
 * history client after system::opened fires.
 */
import { WebSocket } from 'ws';
import { startMockServer } from './mock-server.js';
import { makeClient } from './test-client-factory.js';
import { waitFor } from './helpers.js';
import { CortexClient } from '../src/client.js';
import type { CortexClientPlatform } from '../src/client.js';

describe('getters', () => {
  it('accessToken and cpApiUrl are null before connect()', () => {
    const client = new CortexClient(
      {
        apiKey: 'test-key',
        authUrl: 'http://localhost:9999',
        onMessage: () => {},
        connectTimeout: 1000,
        pingInterval: 60000,
        pongTimeout: 1000,
        staleThreshold: 60000,
      },
      {
        WS: WebSocket as unknown as CortexClientPlatform['WS'],
        fetchFn: () => Promise.reject(new Error('not connected')),
      },
    );

    expect(client.accessToken).toBeNull();
    expect(client.cpApiUrl).toBeNull();
  });

  it('accessToken and cpApiUrl are populated after connect()', async () => {
    const server = await startMockServer({ autoInitEcho: true });
    const client = makeClient(server, () => {});

    try {
      await client.connect();
      await waitFor(() => client.sessionId !== null);

      expect(typeof client.accessToken).toBe('string');
      expect(client.accessToken).toBeTruthy();

      expect(typeof client.cpApiUrl).toBe('string');
      expect(client.cpApiUrl).toContain('127.0.0.1');
    } finally {
      await client.disconnect();
      await server.close();
    }
  });
});
