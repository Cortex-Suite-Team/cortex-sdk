import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { UploadSource } from '../src/file-transfer.js';
import { createUploadSource, type UploadInput } from '../src/upload.js';
import type { UploadFileOptions } from '../src/types.js';

export async function createNodeUploadSource(file: UploadInput | Readable, options: UploadFileOptions = {}): Promise<UploadSource> {
  if (typeof file !== 'string' && !(file instanceof Readable)) return createUploadSource(file, options);
  if (typeof file === 'string') return pathSource(file, options, async () => {});

  const directory = await mkdtemp(join(tmpdir(), 'cortex-sdk-upload-'));
  const path = join(directory, 'payload');
  try {
    await pipeline(file, createWriteStream(path));
    return await pathSource(path, { ...options, filename: options.filename ?? 'upload' }, async () => {
      await rm(directory, { recursive: true, force: true });
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function pathSource(path: string, options: UploadFileOptions, cleanup: () => Promise<void>): Promise<UploadSource> {
  const info = await stat(path);
  return {
    filename: options.filename ?? basename(path),
    contentType: options.contentType ?? 'application/octet-stream',
    size: info.size,
    async *chunks(chunkBytes: number) {
      for await (const chunk of createReadStream(path, { highWaterMark: chunkBytes })) {
        const bytes = chunk as Buffer;
        yield new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      }
    },
    cleanup,
  };
}
