import { startMockServer } from './mock-server.js';
import { makeTestClient, waitFor } from './helpers.js';
import type { CortexMessage, HumanAssistanceNotification } from '../src/types.js';

const deadline = '2099-01-01T00:00:00Z';
function request(requestId: string, options = [{ id: 'approve', label: 'Approve' }]) {
  return { type: 'human_assistance::request', schema: '1.0', session_id: 'sess_abc123',
    payload: { version: 1, request_id: requestId, question: 'Choose and explain?',
      options, allow_text: true, deadline_at: deadline, status: 'pending' },
    ts: new Date().toISOString() };
}
function status(requestId: string, value: string, extra: Record<string, unknown> = {}) {
  return { type: 'human_assistance::status', schema: '1.0', session_id: 'sess_abc123',
    payload: { version: 1, request_id: requestId, status: value, ...extra }, ts: new Date().toISOString() };
}

describe('Human Assistance responder (mock SessionManager)', () => {
  it('keeps DW A active while replying to two independent requests from B', async () => {
    const server = await startMockServer({ autoInitEcho: true, enableSchemaValidation: true });
    const chat: CortexMessage[] = [];
    const events: HumanAssistanceNotification[] = [];
    const client = makeTestClient(server, { onMessage: (message) => chat.push(message) });
    client.onHumanAssistance((event) => events.push(event));
    try {
      await client.connect();
      const a = client.sessionId;
      await client.sendMessage({ content: 'Message to A' });
      server.broadcast({ type: 'chat::question', schema: '1.0', session_id: 'sess_abc123',
        payload: { content: ['Question from A'] }, ts: new Date().toISOString() });
      await waitFor(() => chat.some((item) => item.type === 'chat::question'));
      expect(server.received.some((row) => row['type'] === 'chat::message')).toBe(true);
      const chatBefore = chat.length;
      server.broadcast(request('req-b1'));
      server.broadcast(request('req-b2', []));
      await waitFor(() => events.length === 2);
      expect(events[0]?.type).toBe('human_assistance::request');
      expect(client.sessionId).toBe(a);
      expect(client.sessionState).toBe('ACTIVE');
      expect(chat).toHaveLength(chatBefore);
      expect(client.humanAssistanceRequests.map((item) => item.request_id)).toEqual(['req-b1', 'req-b2']);

      await client.replyHumanAssistance({ requestId: 'req-b1', clientReplyId: 'reply-1',
        action: 'answer', optionId: 'approve', text: 'Because evidence is sufficient.' });
      await client.replyHumanAssistance({ requestId: 'req-b2', clientReplyId: 'reply-2',
        action: 'answer', text: 'Text only answer.' });
      await client.replyHumanAssistance({ requestId: 'req-b1', clientReplyId: 'reply-3',
        action: 'refuse' });
      await waitFor(() => server.received.filter((row) => row['type'] === 'human_assistance::reply').length === 3);
      const replies = server.received.filter((row) => row['type'] === 'human_assistance::reply');
      expect(replies.map((row) => row['session_id'])).toEqual([a, a, a]);
      expect(replies.map((row) => row['payload'])).toEqual([
        { version: 1, request_id: 'req-b1', client_reply_id: 'reply-1', action: 'answer',
          option_id: 'approve', text: 'Because evidence is sufficient.' },
        { version: 1, request_id: 'req-b2', client_reply_id: 'reply-2', action: 'answer', text: 'Text only answer.' },
        { version: 1, request_id: 'req-b1', client_reply_id: 'reply-3', action: 'refuse' },
      ]);
      expect(replies.every((row) => !JSON.stringify(row).includes('wait_token'))).toBe(true);
      expect(server.schemaViolations).toEqual([]);
      expect(chat).toHaveLength(chatBefore);
      expect(client.sessionId).toBe(a);
    } finally { await client.disconnect(); await server.close(); }
  });

  it('collapses replay, validates answers and reports server denials without touching chat', async () => {
    const server = await startMockServer({ autoInitEcho: true });
    const chat: CortexMessage[] = [];
    const events: HumanAssistanceNotification[] = [];
    const client = makeTestClient(server, { onMessage: (message) => chat.push(message) });
    client.onHumanAssistance((event) => events.push(event));
    try {
      await client.connect();
      const a = client.sessionId;
      const chatBefore = chat.length;
      server.broadcast(request('req-b1'));
      await waitFor(() => events.length === 1);
      server.broadcast(request('req-b1'));
      server.broadcast({ ...request('req-b1'), payload: { ...request('req-b1').payload, question: 'Changed?' } });
      server.broadcast({ ...request('req-fake'), session_id: 'foreign-session' });
      server.broadcast({ ...request('req-invalid'), payload: { ...request('req-invalid').payload, wait_token: 'forged' } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(events).toHaveLength(1);
      await expect(client.replyHumanAssistance({ requestId: 'req-fake', clientReplyId: 'fake', action: 'answer', text: 'x' })).rejects.toThrow();
      await expect(client.replyHumanAssistance({ requestId: 'req-b1', clientReplyId: 'bad', action: 'answer' })).rejects.toThrow();
      await expect(client.replyHumanAssistance({ requestId: 'req-b1', clientReplyId: 'bad2', action: 'answer', optionId: 'unknown' })).rejects.toThrow();
      await client.replyHumanAssistance({ requestId: 'req-b1', clientReplyId: 'stable', action: 'answer', optionId: 'approve' });
      await client.replyHumanAssistance({ requestId: 'req-b1', clientReplyId: 'stable', action: 'answer', optionId: 'approve' });
      await expect(client.replyHumanAssistance({ requestId: 'req-b1', clientReplyId: 'stable', action: 'refuse' })).rejects.toThrow();
      server.dropConnections();
      await waitFor(() => server.wsConnectionCount >= 2);
      server.broadcast(request('req-b1'));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(events).toHaveLength(1);
      server.broadcast(status('req-b1', 'reply_rejected', { client_reply_id: 'stable', reason: 'unauthorized' }));
      await waitFor(() => events.length === 2);
      server.broadcast(status('req-b1', 'reply_rejected', { client_reply_id: 'stable', reason: 'unauthorized' }));
      server.broadcast(status('req-b1', 'reply_rejected', { client_reply_id: 'stable', reason: 'duplicate' }));
      await waitFor(() => events.length === 3);
      server.broadcast(status('req-b1', 'reply_rejected', { client_reply_id: 'stable', reason: 'unauthorized' }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(events).toHaveLength(3);
      server.broadcast(status('req-b1', 'expired'));
      await waitFor(() => events.length === 4);
      expect(events[1]).toMatchObject({ type: 'human_assistance::status',
        payload: { status: 'reply_rejected', reason: 'unauthorized', client_reply_id: 'stable' } });
      expect(client.humanAssistanceRequests).toEqual([]);
      await expect(client.replyHumanAssistance({ requestId: 'req-b1', clientReplyId: 'late', action: 'refuse' })).rejects.toThrow();
      expect(client.sessionId).toBe(a);
      expect(chat).toHaveLength(chatBefore);
    } finally { await client.disconnect(); await server.close(); }
  });
});
