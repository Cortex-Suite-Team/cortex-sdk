import { readFileSync } from 'node:fs';
import { decodeCft1, encodeCft1, assertSafePublicControl } from '../src/file-transfer.js';

const contract = JSON.parse(readFileSync(new URL('../../contracts/session_file_ws_v1.json', import.meta.url), 'utf8')) as {
  cft1: {
    magic_ascii: string;
    magic_hex: string;
    header_bytes: number;
    transfer_id_pattern: string;
    sequence_encoding: string;
    default_chunk_bytes: number;
    vectors: Array<{ valid: boolean; transfer_id?: string; sequence?: number; payload_hex?: string; frame_hex?: string }>;
  };
  messages: Record<string, { request: string | null; success: string }>;
  correlation: Record<string, unknown>;
  public_error_codes: string[];
  forbidden_public_fields: string[];
  forbidden_public_value_prefixes: string[];
};

describe('session file WS shared contract', () => {
  it('matches every shared CFT1 vector', () => {
    for (const vector of contract.cft1.vectors) {
      if (vector.valid) {
        const frame = encodeCft1(vector.transfer_id!, vector.sequence!, Buffer.from(vector.payload_hex!, 'hex'));
        expect(Buffer.from(frame).toString('hex')).toBe(vector.frame_hex);
        const decoded = decodeCft1(Buffer.from(vector.frame_hex!, 'hex'));
        expect(decoded.transferId).toBe(vector.transfer_id);
        expect(decoded.sequence).toBe(vector.sequence);
        expect(Buffer.from(decoded.payload).toString('hex')).toBe(vector.payload_hex);
      } else if (vector.frame_hex) {
        expect(() => decodeCft1(Buffer.from(vector.frame_hex!, 'hex'))).toThrow();
      } else {
        expect(() => encodeCft1(vector.transfer_id!, vector.sequence!, new Uint8Array())).toThrow();
      }
    }
  });

  it('locks the complete message, correlation, error, framing, and identity contract', () => {
    expect(Object.fromEntries(Object.entries(contract.messages).map(([key, value]) => [key, [value.request, value.success]]))).toEqual({
      upload_prepare: ['file::upload.prepare', 'file::upload.ready'],
      upload_commit: ['file::upload.commit', 'file::upload.complete'],
      download_prepare: ['file::download.prepare', 'file::download.ready'],
      download_complete: [null, 'file::download.complete'],
      list: ['file::list', 'file::list.result'],
      failure: [null, 'system::error'],
    });
    expect(contract.correlation).toEqual({
      request_field: 'meta.client_msg_id',
      success_echo_field: 'meta.client_msg_id',
      active_transfer_field: 'payload.transfer_id',
      binary_transfer_field: 'CFT1.transfer_id',
      fifo_allowed: false,
    });
    expect(contract.public_error_codes).toEqual([
      'file_transport_unavailable', 'file_too_large', 'file_type_rejected', 'invalid_file_transfer',
      'file_transfer_interrupted', 'file_upload_failed', 'file_download_failed', 'file_unavailable',
    ]);
    expect(contract.forbidden_public_fields).toEqual([
      'file_id', 'snapshot_id', 'blob_ref', 'storage_key', 'ticket', 'upload_ticket',
      'delivery_ticket', 'file_link_secret', 'instance_id',
    ]);
    expect(contract.forbidden_public_value_prefixes).toEqual(['fi_']);
    expect(contract.cft1).toMatchObject({
      magic_ascii: 'CFT1',
      magic_hex: '43465431',
      header_bytes: 24,
      transfer_id_pattern: '^ft_[0-9a-f]{32}$',
      sequence_encoding: 'uint32-big-endian',
      default_chunk_bytes: 262144,
    });
    expect(() => assertSafePublicControl({ nested: { storage_key: 'secret' } })).toThrow();
    expect(() => assertSafePublicControl({ value: 'fi_private' })).toThrow();
  });
});
