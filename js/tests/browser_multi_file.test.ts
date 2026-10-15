/**
 * Browser entry (js/browser) over the EA 3-input / 2-output fixture.
 *
 * Uses the platform WHATWG WebSocket and fetch globals exactly as a browser page
 * would. Node >= 22 provides a native WHATWG WebSocket; older Node (CI runs 20)
 * falls back to the `ws` implementation. Source-level only, not physical evidence.
 */
import { WebSocket as WsWebSocket } from 'ws';

import { CortexClient as BrowserCortexClient } from '../browser/index.js';
import type { CortexMessage } from '../src/types.js';
import { startMockServer } from './mock-server.js';
import { fixture, sha256, SessionFileFake } from './session-file-fake.js';
import { waitFor } from './helpers.js';

describe('browser entry: EA multi-file attachments', () => {
  const globals = globalThis as { WebSocket?: unknown };
  const nativeWebSocket = globals.WebSocket;

  beforeAll(() => {
    if (nativeWebSocket === undefined) globals.WebSocket = WsWebSocket;
  });
  afterAll(() => {
    if (nativeWebSocket === undefined) delete globals.WebSocket;
  });

  it(`uploads 3, receives 2 generated files and downloads each (${nativeWebSocket ? 'native WHATWG WebSocket' : 'ws fallback'})`, async () => {
    let fake!: SessionFileFake;
    const server = await startMockServer({
      autoInitEcho: true, autoChatAnswer: false, autoFileTransport: false,
      onWsMessage: (parsed, ws) => fake.handle(parsed, ws),
    });
    fake = new SessionFileFake(() => server);
    const received: CortexMessage[] = [];
    const client = new BrowserCortexClient({
      apiKey: 'test-key', authUrl: server.httpUrl, onMessage: (msg) => received.push(msg),
      connectTimeout: 2000, pingInterval: 60000, pongTimeout: 1000, staleThreshold: 60000, resyncTimeout: 2000,
    });
    try {
      await client.connect();
      const refs: string[] = [];
      for (const input of fixture.inputs) {
        refs.push(await client.uploadAttachment(new Blob([Buffer.from(input.bytes_hex, 'hex')], { type: input.descriptor.content_type })));
      }
      expect(refs).toEqual(fixture.inputs.map((file) => file.descriptor.file_ref));

      await client.sendMessage({ content: 'Compare the attached revenue files.', attachments: refs, meta: { client_msg_id: fixture.client_msg_id } });
      await waitFor(() => received.some((m) => m.type === 'chat::answer'));
      const answer = received.find((m) => m.type === 'chat::answer')!;
      expect((answer.payload['meta'] as Record<string, unknown>)['attachments']).toEqual(fixture.outputs.map((file) => file.descriptor));

      for (const output of fixture.outputs) {
        const blob = await client.downloadFile(output.descriptor.file_ref);
        expect(sha256(new Uint8Array(await blob.arrayBuffer()))).toBe(output.sha256);
      }
      expect((await client.listFiles()).files.map((file) => file.file_ref))
        .toEqual([...fixture.inputs, ...fixture.outputs].map((file) => file.descriptor.file_ref));
    } finally {
      await client.disconnect();
      await server.close();
    }
  }, 15000);
});
