/**
 * normal_chat transcript test:
 * system::init → system::opened → chat::message → chat::answer
 */
import { startMockServer, FIXED_SESSION_ID } from './mock-server.js';
import { CortexClient } from '../src/client.js';
import { waitFor, makeFetch } from './helpers.js';
import { WebSocket } from 'ws';
import type { CortexClientPlatform } from '../src/client.js';
import type { CortexMessage } from '../src/types.js';

describe('normal_chat', () => {
  it('connect → sendMessage → receives chat::answer', async () => {
    const server = await startMockServer({
      autoChatAnswer: true,
      autoInitEcho: true,
      enableSchemaValidation: true,
    });

    const received: CortexMessage[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const FormDataClass = (globalThis as any).FormData;

    const platform: CortexClientPlatform = {
      WS: WebSocket as unknown as CortexClientPlatform['WS'],
      fetchFn: makeFetch(server.httpUrl),
    };

    const client = new CortexClient(
      {
        apiKey: 'test-key',
        authUrl: server.httpUrl,
        onMessage: (msg) => received.push(msg),
        connectTimeout: 2000,
        pingInterval: 60000,
        pongTimeout: 1000,
        staleThreshold: 60000,
      },
      platform,
    );

    try {
      await client.connect();
      expect(client.sessionId).toBe(FIXED_SESSION_ID);
      expect(client.channelState).toBe('OPEN');

      await client.sendMessage({ content: 'Hello runtime' });

      await waitFor(() => received.some(m => m.type === 'chat::answer' && m.payload['answer_kind'] === 'final'));

      const answer = received.find(m => m.type === 'chat::answer' && m.payload['answer_kind'] === 'final')!;
      expect(answer.payload['role']).toBe('assistant');
      expect(answer.payload['answer_kind']).toBe('final');

      // Verify system::init was sent without session_id
      const initMsg = server.received.find(m => m['type'] === 'system::init');
      expect(initMsg).toBeDefined();
      expect(initMsg!['session_id']).toBeUndefined();
      expect((initMsg!['meta'] as Record<string, unknown>)['client_msg_id'])
        .toEqual(expect.stringMatching(/^cli_init_/));
      expect(server.schemaViolations).toEqual([]);

      // Verify chat::message was sent
      const chatMsg = server.received.find(m => m['type'] === 'chat::message');
      expect(chatMsg).toBeDefined();
      expect((chatMsg!['payload'] as Record<string, unknown>)['content']).toBe('Hello runtime');
      expect((chatMsg!['payload'] as Record<string, unknown>)['role']).toBe('user');

      const rawChatFrame = server.receivedFrames
        .map((frame) => JSON.parse(frame) as Record<string, unknown>)
        .find((frame) => frame['type'] === 'chat::message');
      expect(rawChatFrame).toBeDefined();
      expect(rawChatFrame?.['type']).toBe('chat::message');
      expect(rawChatFrame?.['session_id']).toBe(FIXED_SESSION_ID);
    } finally {
      await client.disconnect();
      await server.close();
    }
  });
});
