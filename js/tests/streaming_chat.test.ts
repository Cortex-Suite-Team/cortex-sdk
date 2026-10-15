/**
 * streaming_chat transcript test:
 * system::init → chat::message → chat::partial ×2 → chat::answer
 * Verifies that the callback is called for each chunk and the final answer.
 */
import { startMockServer, FIXED_SESSION_ID } from './mock-server.js';
import { makeClient } from './test-client-factory.js';
import { waitFor } from './helpers.js';
import type { CortexMessage } from '../src/types.js';

describe('streaming_chat', () => {
  it('receives partial chunks then final answer', async () => {
    let streamSent = false;

    const server = await startMockServer({
      autoChatAnswer: false,
      autoInitEcho: true,
      onWsMessage: (parsed, ws, srv) => {
        if (parsed['type'] === 'chat::message' && !streamSent) {
          streamSent = true;
          let seq = 1;
          const makeEnv = (type: string, payload: Record<string, unknown>) => ({
            type,
            schema: '1.0',
            session_id: FIXED_SESSION_ID,
            seq: seq++,
            payload,
            ts: new Date().toISOString(),
          });
          srv.sendTo(ws, makeEnv('chat::partial', {
            content: ['Quantum entanglement is '],
            role: 'assistant',
            turn: 2,
          }));
          srv.sendTo(ws, makeEnv('chat::partial', {
            content: ['a phenomenon where two particles '],
            role: 'assistant',
            turn: 2,
          }));
          srv.sendTo(ws, makeEnv('chat::answer', {
            content: ['Quantum entanglement is a phenomenon where two particles remain correlated regardless of distance.'],
            role: 'assistant',
            answer_kind: 'final',
            turn: 2,
          }));
        }
      },
    });

    const received: CortexMessage[] = [];
    const client = makeClient(server, (msg) => received.push(msg));

    try {
      await client.connect();
      await waitFor(() => client.sessionId !== null);

      await client.sendMessage({ content: 'Explain quantum entanglement briefly.' });

      await waitFor(() => received.some(m => m.type === 'chat::answer' && m.payload['answer_kind'] === 'final'), 3000);

      const partials = received.filter(m => m.type === 'chat::partial');
      const answer = received.find(m => m.type === 'chat::answer' && m.payload['answer_kind'] === 'final')!;

      expect(partials).toHaveLength(2);
      expect(partials[0].payload['content']).toEqual(['Quantum entanglement is ']);
      expect(partials[1].payload['content']).toEqual(['a phenomenon where two particles ']);
      // Runtime correlates partials with their final answer by the integer turn only.
      expect(answer.payload['turn']).toBe(2);
      for (const partial of partials) {
        expect(partial.payload['turn']).toBe(answer.payload['turn']);
        expect(partial.payload).not.toHaveProperty('turn_id');
      }
      const streamed = partials.flatMap((p) => p.payload['content'] as string[]).join('');
      expect((answer.payload['content'] as string[]).join('').startsWith(streamed)).toBe(true);
      expect(answer.payload['answer_kind']).toBe('final');
      expect(received.filter(m => m.type === 'chat::partial' || m.type === 'chat::answer').length)
        .toBeGreaterThanOrEqual(3);
    } finally {
      await client.disconnect();
      await server.close();
    }
  });
});
