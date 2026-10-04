import { readFileSync } from 'node:fs';
import { decodeCft1, encodeCft1, assertSafePublicControl } from '../src/file-transfer.js';

const contract = JSON.parse(readFileSync(new URL('../../contracts/session_file_ws_v1.json', import.meta.url), 'utf8')) as {
  cft1: { vectors: Array<{ valid: boolean; transfer_id?: string; sequence?: number; payload_hex?: string; frame_hex?: string }> };
  messages: Record<string, { request: string | null; success: string }>;
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

  it('locks message names and the public identity firewall', () => {
    expect(contract.messages.upload_prepare).toMatchObject({ request: 'file::upload.prepare', success: 'file::upload.ready' });
    expect(() => assertSafePublicControl({ nested: { storage_key: 'secret' } })).toThrow();
    expect(() => assertSafePublicControl({ value: 'fi_private' })).toThrow();
  });
});
