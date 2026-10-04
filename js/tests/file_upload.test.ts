/**
 * file_upload transcript test:
 * init → [HTTP upload → file_ref] → chat::message with payload.meta.attachments → chat::answer
 */
import { startMockServer, FIXED_SESSION_ID, FIXED_ATTACHMENT_ID } from './mock-server.js';
import { makeClient } from './test-client-factory.js';
import { waitFor } from './helpers.js';
import type { CortexMessage } from '../src/types.js';

describe('file_upload', () => {
  it('uploads file and sends message with attachment reference', async () => {
    const server = await startMockServer({
      autoInitEcho: true,
      autoChatAnswer: false,
      onWsMessage: (parsed, ws, srv) => {
        if (parsed['type'] === 'chat::message') {
          // Echo back with attachment reference confirmed
          srv.sendTo(ws, {
            type: 'chat::answer',
            schema: '1.0',
            session_id: FIXED_SESSION_ID,
            seq: 1,
            payload: {
              content: 'The document covers three main topics.',
              role: 'assistant',
              answer_kind: 'final',
              turn_id: 'turn_006',
            },
            ts: new Date().toISOString(),
          });
        }
      },
    });

    const received: CortexMessage[] = [];
    const client = makeClient(server, (msg) => received.push(msg));

    try {
      await client.connect();
      await waitFor(() => client.sessionId !== null);

      // Upload a file (mock server returns FIXED_ATTACHMENT_ID for any upload)
      const fakeFile = new Uint8Array([1, 2, 3, 4]);
      const fileRef = await client.uploadFile(fakeFile);
      expect(fileRef).toBe(FIXED_ATTACHMENT_ID);

      const attachmentId = await client.uploadAttachment(fakeFile);
      expect(attachmentId).toBe(FIXED_ATTACHMENT_ID);

      const sessionBytes = await client.downloadFile(attachmentId);
      expect(await sessionBytes.text()).toBe('mock file bytes');

      const sessionFiles = await client.listFiles();
      expect(sessionFiles.total).toBe(1);
      expect(sessionFiles.files[0]?.file_ref).toBe(FIXED_ATTACHMENT_ID);
      expect(sessionFiles.files[0]).not.toHaveProperty('file_id');

      const projectFiles = await client.listFiles({ scope: 'project', projectId: 42 });
      expect(projectFiles.total).toBe(1);

      const promoted = await client.promoteFile(attachmentId, { projectId: 42 });
      expect(promoted.file_ref).toBe(FIXED_ATTACHMENT_ID);
      expect(promoted).not.toHaveProperty('file_id');

      const mintedUrl = await client.mintSessionFileDownloadUrl(attachmentId);
      expect(mintedUrl).toBe(`${server.httpUrl}/download-token/mock`);

      const projectBytes = await client.downloadFile(attachmentId, {
        scope: 'project',
        projectId: 42,
      });
      expect(await projectBytes.text()).toBe('project file bytes');

      // Send message with the attachment
      await client.sendMessage({
        content: 'Please summarize this document.',
        attachments: [attachmentId],
      });

      await expect(client.sendMessage({
        content: 'Do not leak internal identity.',
        attachments: [{ file_ref: attachmentId, file_id: 'fi_private' } as never],
      })).rejects.toMatchObject({ code: 'transport_protocol_violation' });

      await waitFor(() => received.some(m => m.type === 'chat::answer' && m.payload['answer_kind'] === 'final'), 3000);

      // Verify the chat::message was sent with the attachment
      const chatMsg = server.received.find(m => m['type'] === 'chat::message');
      expect(chatMsg).toBeDefined();
      const msgPayload = chatMsg!['payload'] as Record<string, unknown>;
      expect((msgPayload['meta'] as Record<string, unknown>)['attachments']).toEqual([
        { file_ref: FIXED_ATTACHMENT_ID },
      ]);
      expect(msgPayload).not.toHaveProperty('attachments');
      expect(msgPayload['content']).toBe('Please summarize this document.');

      const answer = received.find(m => m.type === 'chat::answer' && m.payload['answer_kind'] === 'final')!;
      expect(answer.payload['turn_id']).toBe('turn_006');
    } finally {
      await client.disconnect();
      await server.close();
    }
  });
});
