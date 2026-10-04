import { createTransport } from '../src/transport.js';
import type { WebSocketLike } from '../src/types.js';

class FakeSocket implements WebSocketLike {
  static latest: FakeSocket;
  readyState = 1;
  bufferedAmount = 0;
  binaryType = '';
  sent: Array<string | ArrayBuffer | Uint8Array> = [];
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string | Buffer }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: WebSocketLike['onmessage'] = null;
  constructor(_url: string, _protocols: string[]) {
    FakeSocket.latest = this;
    queueMicrotask(() => this.onopen?.({}));
  }
  send(data: string | ArrayBuffer | Uint8Array): void { this.sent.push(data); }
  close(code = 1000, reason = 'closed'): void { this.readyState = 3; this.onclose?.({ code, reason }); }
}

describe('binary WebSocket transport', () => {
  it('keeps text and binary dispatch separate', async () => {
    const transport = createTransport(FakeSocket, 100);
    const text: string[] = [];
    const binary: Uint8Array[] = [];
    transport.onText = (value) => text.push(value);
    transport.onBinary = (value) => binary.push(value);
    await transport.open('ws://test', 'token');
    expect(FakeSocket.latest.binaryType).toBe('arraybuffer');
    FakeSocket.latest.onmessage?.({ data: '{"ok":true}' });
    FakeSocket.latest.onmessage?.({ data: new Uint8Array([0xff, 0x00]).buffer });
    expect(text).toEqual(['{"ok":true}']);
    expect(Array.from(binary[0] ?? [])).toEqual([255, 0]);
  });

  it('bounds bufferedAmount waiting and close interrupts it', async () => {
    const transport = createTransport(FakeSocket, 100);
    await transport.open('ws://test', 'token');
    FakeSocket.latest.bufferedAmount = 1024 * 1024 + 1;
    const first = transport.sendBinary(new Uint8Array([1]), 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(FakeSocket.latest.sent).toHaveLength(0);
    FakeSocket.latest.bufferedAmount = 0;
    await first;
    expect(FakeSocket.latest.sent).toHaveLength(1);

    FakeSocket.latest.bufferedAmount = 1024 * 1024 + 1;
    const interrupted = transport.sendBinary(new Uint8Array([2]), 200);
    transport.close();
    await expect(interrupted).rejects.toMatchObject({ code: 'file_transfer_interrupted' });
  });
});
