import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUploadSource } from '../src/upload.js';
import { createNodeUploadSource } from '../node/upload-node.js';

describe('upload source metadata', () => {
  it('preserves browser File metadata and streams exact bytes', async () => {
    const file = Object.assign(new Blob(['hello'], { type: 'text/plain' }), { name: 'example.txt' });
    const source = createUploadSource(file);
    expect(source).toMatchObject({ filename: 'example.txt', contentType: 'text/plain', size: 5 });
    const chunks: number[] = [];
    for await (const chunk of source.chunks(2)) chunks.push(...chunk);
    expect(new TextDecoder().decode(new Uint8Array(chunks))).toBe('hello');
  });

  it('uses explicit metadata for byte inputs', () => {
    const source = createUploadSource(new Uint8Array([1, 2, 3]), { filename: 'data.bin', contentType: 'x/test' });
    expect(source).toMatchObject({ filename: 'data.bin', contentType: 'x/test', size: 3 });
  });

  it('uses basename and streams a Node path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cortex-sdk-test-'));
    const path = join(directory, 'invoice.pdf');
    try {
      await writeFile(path, 'hello');
      const source = await createNodeUploadSource(path);
      expect(source).toMatchObject({ filename: 'invoice.pdf', size: 5 });
      const chunks: Buffer[] = [];
      for await (const chunk of source.chunks(2)) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe('hello');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
