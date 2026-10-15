/**
 * Shared EA multi-file fixture and strict SessionManager-like peer (Edge #6 contract).
 * Source-level test double only; not physical SessionManager/File Link evidence.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { WebSocket } from 'ws';

import type { SessionFileDescriptor } from '../src/types.js';
import { FIXED_SESSION_ID, type MockServer } from './mock-server.js';

export interface FixtureFile { descriptor: SessionFileDescriptor; bytes_hex: string; sha256: string }
export interface Fixture {
  limits: { max_attachments_per_message: number };
  public_descriptor_fields: string[];
  client_msg_id: string;
  turn: number;
  turn_ref: string;
  inputs: FixtureFile[];
  outputs: FixtureFile[];
  messages: {
    chat_message: Record<string, unknown>;
    chat_echo: Record<string, unknown>;
    chat_answer: Record<string, unknown>;
    file_list_result: Record<string, unknown>;
  };
  send_rejections: Array<{ name: string; attachments: unknown[]; error_code: string }>;
  server_attachment_errors: Array<{ name: string; payload: { code: string; message: string }; retryable: boolean; fatal: boolean }>;
  hostile_descriptors: Array<{ name: string; input: unknown; expected: SessionFileDescriptor | null }>;
  message_projection_cases: Array<{ name: string; type: string; payload: Record<string, unknown>; expected_refs: string[] }>;
  runtime_answer_schema_cases: Array<{ name: string; valid: boolean; payload: Record<string, unknown> }>;
  runtime_partial_schema_cases: Array<{ name: string; valid: boolean; payload: Record<string, unknown> }>;
  runtime_echo_schema_cases: Array<{ name: string; valid: boolean; payload: Record<string, unknown> }>;
  unbound_list_entries: Array<{ name: string; descriptor: Record<string, unknown> }>;
}

export const fixture = JSON.parse(
  readFileSync(new URL('../../contracts/session_file_attachments_v1.json', import.meta.url), 'utf8'),
) as Fixture;

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Strict SessionManager-like peer for the Edge #6 session-file contract. */
export class SessionFileFake {
  readonly records = new Map<string, { descriptor: SessionFileDescriptor; bytes: Buffer }>();
  readonly order: string[] = [];
  uploadPrepareCount = 0;
  dropNextEcho = false;
  private transfers = new Map<string, { index: number; filename: string; size: number }>();
  private nextTransfer = 1;
  private nextInput = 0;

  constructor(private readonly server: () => MockServer) {
    for (const output of fixture.outputs) {
      // Generated files already published by Runtime #24 via session-file-register.
      this.records.set(output.descriptor.file_ref, { descriptor: output.descriptor, bytes: Buffer.from(output.bytes_hex, 'hex') });
    }
  }

  handle(parsed: Record<string, unknown>, ws: WebSocket): void {
    const type = parsed['type'];
    const payload = (parsed['payload'] ?? {}) as Record<string, unknown>;
    const meta = (parsed['meta'] ?? {}) as Record<string, unknown>;
    const correlation = { client_msg_id: meta['client_msg_id'] };
    const send = (msg: Record<string, unknown>) => this.server().sendTo(ws, { schema: '1.0', session_id: FIXED_SESSION_ID, ts: new Date().toISOString(), ...msg });
    if (type === 'file::upload.prepare') {
      this.uploadPrepareCount++;
      const transferId = `ft_${(this.nextTransfer++).toString(16).padStart(32, '0')}`;
      this.transfers.set(transferId, { index: this.nextInput++, filename: payload['filename'] as string, size: payload['size'] as number });
      send({ type: 'file::upload.ready', payload: { transfer_id: transferId, chunk_bytes: 64, max_bytes: 1 << 20 }, meta: correlation });
    } else if (type === 'file::upload.commit') {
      const transferId = payload['transfer_id'] as string;
      const transfer = this.transfers.get(transferId)!;
      const bytes = Buffer.concat(this.server().receivedFrames
        .filter((hex) => hex.startsWith('43465431') && hex.slice(8, 40) === transferId.slice(3))
        .map((hex) => Buffer.from(hex, 'hex').subarray(24)));
      const input = fixture.inputs[transfer.index]!;
      const { message_ref: _ref, message_ref_kind: _kind, ...unbound } = input.descriptor;
      expect(sha256(bytes)).toBe(input.sha256);
      expect(bytes.length).toBe(transfer.size);
      this.records.set(input.descriptor.file_ref, { descriptor: unbound as SessionFileDescriptor, bytes });
      this.order.push(input.descriptor.file_ref);
      send({ type: 'file::upload.complete', payload: { transfer_id: transferId, file_ref: input.descriptor.file_ref }, meta: correlation });
    } else if (type === 'file::download.prepare') {
      const record = this.records.get(payload['file_ref'] as string);
      if (!record || record.descriptor.state !== 'available') {
        send({ type: 'system::error', payload: { code: 'file_unavailable', message: 'File is unavailable' }, meta: correlation });
        return;
      }
      const transferId = `ft_${(this.nextTransfer++).toString(16).padStart(32, '0')}`;
      const { descriptor, bytes } = record;
      send({ type: 'file::download.ready', payload: { transfer_id: transferId, file_ref: descriptor.file_ref, filename: descriptor.filename, content_type: descriptor.content_type, size: bytes.length, chunk_bytes: 64 }, meta: correlation });
      let sequence = 0;
      for (let offset = 0; offset === 0 || offset < bytes.length; offset += 64) {
        const header = Buffer.alloc(24);
        header.write('CFT1', 0, 'ascii');
        Buffer.from(transferId.slice(3), 'hex').copy(header, 4);
        header.writeUInt32BE(sequence++, 20);
        ws.send(Buffer.concat([header, bytes.subarray(offset, offset + 64)]), { binary: true });
        if (bytes.length === 0) break;
      }
      send({ type: 'file::download.complete', payload: { transfer_id: transferId } });
    } else if (type === 'file::list') {
      const refs = [...this.order, ...fixture.outputs.map((file) => file.descriptor.file_ref)];
      const files = refs.map((ref) => this.records.get(ref)!.descriptor);
      send({ type: 'file::list.result', payload: { files, total: files.length }, meta: correlation });
    } else if (type === 'chat::message') {
      this.handleChat(payload, send);
    }
  }

  private handleChat(payload: Record<string, unknown>, send: (msg: Record<string, unknown>) => void): void {
    const meta = (payload['meta'] ?? {}) as Record<string, unknown>;
    const clientMsgId = meta['client_msg_id'] as string;
    const refs = ((meta['attachments'] ?? []) as Array<{ file_ref: string }>).map((a) => a.file_ref);
    const error = (code: string, message: string) => send({ type: 'system::error', payload: { code, message }, meta: { client_msg_id: clientMsgId } });
    if (refs.length > fixture.limits.max_attachments_per_message) { error('too_many_attachments', 'At most 8 file(s) may be attached per message.'); return; }
    // Whole-list validation before any binding (Edge #6 cas_raw_many semantics).
    for (const ref of refs) {
      const record = this.records.get(ref);
      if (!record || record.descriptor.owner_role !== 'user') { error('invalid_attachment', `${ref}: session file not found`); return; }
      if (record.descriptor.message_ref !== undefined && record.descriptor.message_ref !== clientMsgId) { error('invalid_attachment', `${ref}: message binding conflict`); return; }
    }
    const bound = refs.map((ref) => {
      const record = this.records.get(ref)!;
      record.descriptor = { ...record.descriptor, message_ref: clientMsgId, message_ref_kind: 'client_msg_id' };
      return record.descriptor;
    });
    if (bound.length === 0) return;
    if (this.dropNextEcho) { this.dropNextEcho = false; return; }
    // Hostile upstream: internal identity/URLs next to sf_ refs and an inherited user upload in the answer.
    send({ type: 'chat::echo', payload: { content: [payload['content']], role: 'user', meta: { client_msg_id: clientMsgId, attachments: bound.map((d, i) => ({ ...d, file_id: `fi_${i}`, snapshot_id: `sn_${i}` })) } } });
    const outputs = fixture.outputs.map((file) => file.descriptor);
    send({
      type: 'chat::answer',
      payload: {
        ...fixture.messages.chat_answer,
        meta: {
          billing: { summary: { authoritative: false } },
          attachments: [bound[0], { ...outputs[0], download_mint_url: 'https://evil.example/mint', delivery_ticket: 'tkt' }, outputs[1], outputs[0]],
        },
      },
    });
  }
}

