/**
 * EA multi-file contract (SDK #2): 3 user files -> one chat::message -> 2 generated files.
 *
 * Driven by contracts/session_file_attachments_v1.json. The WebSocket peer is a
 * strict SessionManager-like fake built from the Edge #6 source contract; this is
 * source-level qualification, NOT physical SessionManager/File Link evidence.
 */
import { readFileSync } from 'node:fs';

import Ajv from 'ajv';

import {
  normalizeSessionFileAttachments,
  parseMessageAttachments,
  parsePublicAttachment,
  parseSessionFileList,
} from '../src/files.js';
import { MAX_ATTACHMENTS_PER_MESSAGE } from '../src/constants.js';
import type { CortexMessage, SessionFileAttachmentInput, SessionFileDescriptor } from '../src/types.js';
import { FIXED_SESSION_ID, startMockServer } from './mock-server.js';
import { fixture, sha256, SessionFileFake } from './session-file-fake.js';
import { makeClient } from './test-client-factory.js';
import { waitFor } from './helpers.js';

const FORBIDDEN_JSON = /"(fi_|sn_)|file_id|snapshot_id|scope_type|scope_id|storage_key|ticket|download_mint_url|download_url|upload_path|"url"/;

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
function schema(name: string) {
  if (!validators.has(name)) {
    validators.set(name, ajv.compile(JSON.parse(readFileSync(new URL(`../../shared/schema/${name}`, import.meta.url), 'utf8')) as object));
  }
  return validators.get(name)!;
}

function answerWith(attachments: unknown): CortexMessage {
  return {
    type: 'chat::answer', schema: '1.0', session_id: FIXED_SESSION_ID, ts: new Date().toISOString(),
    payload: { ...fixture.messages.chat_answer, meta: { attachments } },
  };
}

function echoWith(attachments: unknown): CortexMessage {
  return {
    type: 'chat::echo', schema: '1.0', session_id: FIXED_SESSION_ID, ts: new Date().toISOString(),
    payload: { ...fixture.messages.chat_echo, meta: { client_msg_id: fixture.client_msg_id, attachments } },
  };
}

describe('session file attachments contract fixture', () => {
  it('pins the shared limit and the nine public descriptor fields', () => {
    expect(fixture.limits.max_attachments_per_message).toBe(MAX_ATTACHMENTS_PER_MESSAGE);
    for (const file of [...fixture.inputs, ...fixture.outputs]) {
      expect(Object.keys(file.descriptor).sort()).toEqual([...fixture.public_descriptor_fields].sort());
      expect(file.descriptor.size).toBe(file.bytes_hex.length / 2);
      expect(sha256(Buffer.from(file.bytes_hex, 'hex'))).toBe(file.sha256);
    }
  });

  it('validates every fixture message against the shared schemas', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['chat.message.json', fixture.messages.chat_message],
      ['chat.echo.json', fixture.messages.chat_echo],
      ['chat.answer.json', fixture.messages.chat_answer],
      ['file.list.result.json', fixture.messages.file_list_result],
    ];
    for (const [name, payload] of cases) {
      const validate = schema(name);
      expect({ name, valid: validate(payload), errors: validate.errors ?? null }).toEqual({ name, valid: true, errors: null });
    }
  });

  it('schemas reject internal fields, inherited user files and URL injection', () => {
    const validateAnswer = schema('chat.answer.json');
    const validateList = schema('file.list.result.json');
    const answer = fixture.messages.chat_answer;
    for (const hostile of fixture.hostile_descriptors) {
      // The schema accepts exactly the descriptors the projection leaves untouched.
      const clean = hostile.expected !== null && JSON.stringify(hostile.expected) === JSON.stringify(hostile.input);
      expect([hostile.name, validateAnswer({ ...answer, meta: { attachments: [hostile.input] } })]).toEqual([hostile.name, clean]);
      if (hostile.expected) {
        expect(validateAnswer({ ...answer, meta: { attachments: [hostile.expected] } })).toBe(true);
      }
    }
    expect(validateAnswer({ ...answer, meta: { attachments: [fixture.inputs[0]!.descriptor] } })).toBe(false);
    expect(validateList({ files: [{ ...fixture.outputs[0]!.descriptor, file_id: 'fi_x' }], total: 1 })).toBe(false);
    // Runtime metadata other than attachments still passes through.
    expect(validateAnswer({ ...answer, meta: { ...(answer['meta'] as object), billing: { summary: {} } } })).toBe(true);
  });

  it.each(fixture.hostile_descriptors.map((c) => [c.name, c] as const))('public projection: %s', (_name, vector) => {
    expect(parsePublicAttachment(vector.input)).toEqual(vector.expected);
  });

  it.each(fixture.answer_projection_cases.map((c) => [c.name, c] as const))('answer attachments: %s', (_name, vector) => {
    expect(parseMessageAttachments(answerWith(vector.attachments)).map((d) => d.file_ref)).toEqual(vector.expected_refs);
  });

  it.each(fixture.echo_projection_cases.map((c) => [c.name, c] as const))('echo attachments: %s', (_name, vector) => {
    expect(parseMessageAttachments(echoWith(vector.attachments)).map((d) => d.file_ref)).toEqual(vector.expected_refs);
  });

  it('binds an answer by numeric turn as well as turn_id', () => {
    const outputs = fixture.outputs.map((file) => ({ ...file.descriptor, message_ref: '7' }));
    const byTurn: CortexMessage = {
      type: 'chat::answer', schema: '1.0', ts: '', payload: { content: ['x'], role: 'assistant', answer_kind: 'final', turn: 7, meta: { attachments: outputs } },
    };
    expect(parseMessageAttachments(byTurn)).toEqual(outputs);
    expect(parseMessageAttachments({ ...byTurn, payload: { ...byTurn.payload, turn: 8 } })).toEqual([]);
  });

  it.each(fixture.send_rejections.map((c) => [c.name, c] as const))('send rejection: %s', (_name, vector) => {
    expect(() => normalizeSessionFileAttachments(vector.attachments as SessionFileAttachmentInput[]))
      .toThrow(expect.objectContaining({ code: vector.error_code, retryable: false, fatal: false }));
  });

  it('keeps 0, 1, 3 and 8 attachments in client order', () => {
    expect(normalizeSessionFileAttachments([])).toEqual([]);
    expect(normalizeSessionFileAttachments(['sf_one'])).toEqual([{ file_ref: 'sf_one' }]);
    const refs = fixture.inputs.map((file) => file.descriptor.file_ref);
    expect(normalizeSessionFileAttachments(refs)).toEqual(refs.map((file_ref) => ({ file_ref })));
    const eight = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, i) => `sf_n${i}`);
    expect(normalizeSessionFileAttachments(eight).map((a) => a['file_ref'])).toEqual(eight);
  });

  it('rejects the whole session file list when any entry is not a public descriptor', () => {
    expect(parseSessionFileList(fixture.messages.file_list_result).files)
      .toEqual([...fixture.inputs, ...fixture.outputs].map((file) => file.descriptor));
    expect(() => parseSessionFileList({ files: [{ ...fixture.outputs[0]!.descriptor, size: -1 }], total: 1 }))
      .toThrow(expect.objectContaining({ code: 'file_operation_failed' }));
  });
});

describe('EA 3-input / 2-output session files over the SDK WebSocket', () => {
  it('uploads three files, sends one message, downloads both generated files, survives retry and reconnect', async () => {
    let fake!: SessionFileFake;
    let resyncs = 0;
    const server = await startMockServer({
      autoInitEcho: true,
      autoChatAnswer: false,
      autoFileTransport: false,
      onWsMessage: (parsed, ws) => {
        if (parsed['type'] === 'system::resync') resyncs++;
        fake.handle(parsed, ws);
      },
    });
    fake = new SessionFileFake(() => server);
    const received: CortexMessage[] = [];
    const client = makeClient(server, (msg) => received.push(msg));
    const inputRefs = fixture.inputs.map((file) => file.descriptor.file_ref);
    const outputDescriptors = fixture.outputs.map((file) => file.descriptor);

    try {
      await client.connect();

      // 1. Three independent uploads -> three canonical sf_ refs, in order.
      const refs: string[] = [];
      for (const input of fixture.inputs) {
        refs.push(await client.uploadAttachment(new Uint8Array(Buffer.from(input.bytes_hex, 'hex'))));
      }
      expect(refs).toEqual(inputRefs);

      // 2. Lost send response: the server binds but the echo/answer never arrive;
      //    the retry reuses client_msg_id and refs without re-uploading.
      fake.dropNextEcho = true;
      const message = { content: 'Compare the attached revenue files.', attachments: refs, meta: { client_msg_id: fixture.client_msg_id } };
      await client.sendMessage(message);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(received.some((m) => m.type === 'chat::echo')).toBe(false);
      await client.sendMessage(message);
      await waitFor(() => received.some((m) => m.type === 'chat::answer'));
      expect(fake.uploadPrepareCount).toBe(3);

      const sent = server.received.filter((m) => m['type'] === 'chat::message').map((m) => m['payload']);
      expect(sent).toEqual([fixture.messages.chat_message, fixture.messages.chat_message]);
      expect(sent[0]).not.toHaveProperty('attachments');

      // 3. Echo carries exactly the three user files; the answer exactly the two
      //    generated files -- no inherited upload, duplicate or internal field.
      const echo = received.find((m) => m.type === 'chat::echo')!;
      expect((echo.payload['meta'] as Record<string, unknown>)['attachments'])
        .toEqual((fixture.messages.chat_echo['meta'] as Record<string, unknown>)['attachments']);
      const answer = received.find((m) => m.type === 'chat::answer')!;
      expect((answer.payload['meta'] as Record<string, unknown>)['attachments']).toEqual(outputDescriptors);
      expect((answer.payload['meta'] as Record<string, unknown>)['billing']).toEqual({ summary: { authoritative: false } });
      expect(JSON.stringify(received)).not.toMatch(FORBIDDEN_JSON);

      // 4. Each generated file downloads independently with exact bytes.
      for (const output of fixture.outputs) {
        const blob = await client.downloadFile(output.descriptor.file_ref);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        expect(sha256(bytes)).toBe(output.sha256);
        expect(blob.type).toBe(output.descriptor.content_type);
      }
      const both = await Promise.all(fixture.outputs.map((output) => client.downloadFile(output.descriptor.file_ref)));
      expect(await Promise.all(both.map(async (blob) => sha256(new Uint8Array(await blob.arrayBuffer())))))
        .toEqual(fixture.outputs.map((output) => output.sha256));

      // 5. Reconnect, then rediscover every public ref with its message association.
      server.dropConnections();
      await waitFor(() => resyncs === 1 && client.channelState === 'OPEN', 6000);
      const listed = await client.listFiles();
      expect(listed).toEqual(fixture.messages.file_list_result);
      expect(JSON.stringify(listed)).not.toMatch(FORBIDDEN_JSON);
      const again = await client.downloadFile(fixture.outputs[1]!.descriptor.file_ref);
      expect(sha256(new Uint8Array(await again.arrayBuffer()))).toBe(fixture.outputs[1]!.sha256);
    } finally {
      await client.disconnect();
      await server.close();
    }
  }, 20000);

  it('classifies limit, duplicate, server attachment and missing-file errors without failing the session', async () => {
    let fake!: SessionFileFake;
    const server = await startMockServer({
      autoInitEcho: true, autoChatAnswer: false, autoFileTransport: false,
      onWsMessage: (parsed, ws) => fake.handle(parsed, ws),
    });
    fake = new SessionFileFake(() => server);
    const received: CortexMessage[] = [];
    const client = makeClient(server, (msg) => received.push(msg));
    try {
      await client.connect();
      const nine = Array.from({ length: 9 }, (_, i) => `sf_n${i}`);
      await expect(client.sendMessage({ content: 'x', attachments: nine })).rejects.toMatchObject({ code: 'too_many_attachments', retryable: false });
      await expect(client.sendMessage({ content: 'x', attachments: ['sf_a', 'sf_a'] })).rejects.toMatchObject({ code: 'invalid_attachment' });
      // Raw meta.attachments get the same validation as the attachments argument.
      await expect(client.sendMessage({ content: 'x', meta: { attachments: ['fi_0123456789abcdef'] } })).rejects.toMatchObject({ code: 'invalid_attachment' });
      await expect(client.sendMessage({ content: 'x', meta: { attachments: [{ file_ref: 'sf_a', download_mint_url: 'https://evil.example' }] } })).rejects.toMatchObject({ code: 'invalid_attachment' });
      expect(server.received.filter((m) => m['type'] === 'chat::message')).toHaveLength(0);
      await client.sendMessage({ content: 'x', attachments: [], meta: { client_msg_id: 'cli_msg_empty', attachments: ['fi_ignored'] } });
      await client.sendMessage({ content: 'x', meta: { client_msg_id: 'cli_msg_one', attachments: [{ file_ref: fixture.outputs[0]!.descriptor.file_ref }] } });
      await waitFor(() => server.received.filter((m) => m['type'] === 'chat::message').length === 2);
      expect(server.received.filter((m) => m['type'] === 'chat::message').map((m) => m['payload'])).toEqual([
        { content: 'x', role: 'user', meta: { client_msg_id: 'cli_msg_empty' } },
        { content: 'x', role: 'user', meta: { client_msg_id: 'cli_msg_one', attachments: [{ file_ref: fixture.outputs[0]!.descriptor.file_ref }] } },
      ]);
      // The second one is rejected server-side (assistant file as user attachment); discard both.
      await waitFor(() => received.some((m) => m.type === 'system::error'));
      received.length = 0;

      // Server-side rejection carries the rejected message's client_msg_id.
      await client.sendMessage({ content: 'x', attachments: ['sf_unknown'], meta: { client_msg_id: 'cli_msg_bad' } });
      await waitFor(() => received.some((m) => m.type === 'system::error'));
      const error = received.find((m) => m.type === 'system::error')!;
      expect(error.payload['code']).toBe('invalid_attachment');
      expect(error.meta?.['client_msg_id']).toBe('cli_msg_bad');
      expect(client.sessionState).toBe('ACTIVE');
      expect(client.channelState).toBe('OPEN');

      // Missing/expired generated file: a correlated, non-fatal download error.
      await expect(client.downloadFile('sf_out_missing')).rejects.toMatchObject({ code: 'file_unavailable' });
      fake.records.get(fixture.outputs[0]!.descriptor.file_ref)!.descriptor = { ...fixture.outputs[0]!.descriptor, state: 'expired' };
      await expect(client.downloadFile(fixture.outputs[0]!.descriptor.file_ref)).rejects.toMatchObject({ code: 'file_unavailable' });
      const listed = await client.listFiles();
      expect(listed.files.map((file) => [file.file_ref, file.state])).toEqual([
        [fixture.outputs[0]!.descriptor.file_ref, 'expired'],
        [fixture.outputs[1]!.descriptor.file_ref, 'available'],
      ]);
      // A message-supplied URL is never a download path: only sf_ refs are accepted.
      await expect(client.downloadFile('https://evil.example/f')).rejects.toMatchObject({ code: 'file_operation_failed' });
      await expect(client.downloadFile('fi_0123456789abcdef')).rejects.toMatchObject({ code: 'file_operation_failed' });
      expect(client.sessionState).toBe('ACTIVE');
    } finally {
      await client.disconnect();
      await server.close();
    }
  });

  it.each(fixture.server_attachment_errors.map((c) => [c.name, c] as const))('catalog classifies %s', async (_name, vector) => {
    const { lookupError } = await import('../src/errors.js');
    expect(lookupError(vector.payload.code)).toEqual({ code: vector.payload.code, retryable: vector.retryable, fatal: vector.fatal });
  });
});
