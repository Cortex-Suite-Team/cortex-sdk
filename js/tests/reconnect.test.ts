/**
 * reconnect_resync transcript test:
 * init → message → [channel drop] → system::resync (with last_seq) → chat::answer replay
 */
import { startMockServer, FIXED_SESSION_ID } from './mock-server.js';
import { makeClient } from './test-client-factory.js';
import { waitFor } from './helpers.js';
import type { CortexMessage } from '../src/types.js';

describe('reconnect_resync', () => {
  it('reconnects after channel drop and sends system::resync with last_seq', async () => {
    let resynced = false;

    const server = await startMockServer({
      autoInitEcho: true,
      autoChatAnswer: false,
      onWsMessage: (parsed, ws, srv) => {
        const type = parsed['type'];

        if (type === 'chat::message') {
          // Don't answer yet — the "answer" will come after reconnect replay
        }

        if (type === 'system::resync') {
          resynced = true;
          const payload = parsed['payload'] as Record<string, unknown>;
          // Verify last_seq is present and is a number
          expect(typeof payload['last_seq']).toBe('number');

          // Replay the answer
          srv.sendTo(ws, {
            type: 'chat::answer',
            schema: '1.0',
            session_id: FIXED_SESSION_ID,
            seq: 1,
            payload: {
              content: ['Long task completed'],
              role: 'assistant',
              answer_kind: 'final',
              turn: 3,
            },
            ts: new Date().toISOString(),
          });
        }
      },
    });

    const received: CortexMessage[] = [];
    const client = makeClient(server, (msg) => received.push(msg), {
      pingInterval: 60000,
      staleThreshold: 60000,
    });

    try {
      await client.connect();
      await waitFor(() => client.sessionId !== null);

      // Send a message (no answer will come)
      await client.sendMessage({ content: 'Start a long task' });

      // Drop all connections
      server.dropConnections();

      // Wait for reconnect and resync
      await waitFor(() => resynced, 5000);

      // Wait for the replayed answer
      await waitFor(() => received.some(m => m.type === 'chat::answer' && m.payload['answer_kind'] === 'final'), 5000);

      const answer = received.find(m => m.type === 'chat::answer' && m.payload['answer_kind'] === 'final')!;
      expect(answer.payload['content']).toEqual(['Long task completed']);
      expect(answer.payload['turn']).toBe(3);

      // Verify resync payload had last_seq
      const resyncMsg = server.received.find(m => m['type'] === 'system::resync');
      expect(resyncMsg).toBeDefined();
      expect(typeof (resyncMsg!['payload'] as Record<string, unknown>)['last_seq']).toBe('number');
    } finally {
      await client.disconnect();
      await server.close();
    }
  });
});
