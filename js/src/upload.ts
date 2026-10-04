import { makeError } from './errors.js';
import type { UploadSource } from './file-transfer.js';
import type { UploadFileOptions } from './types.js';

export type UploadInput = Blob | ArrayBuffer | string | Uint8Array;

export function createUploadSource(file: UploadInput, options: UploadFileOptions = {}): UploadSource {
  if (typeof file === 'string') throw makeError('file_type_rejected', 'File paths require the Node entry point');
  const blob = file instanceof Blob
    ? file
    : file instanceof ArrayBuffer
      ? new Blob([file])
      : new Blob([Uint8Array.from(file).buffer]);
  const named = file as unknown as { name?: unknown };
  const fileName = typeof named.name === 'string' ? named.name : undefined;
  return {
    filename: options.filename ?? fileName ?? 'upload',
    contentType: blob.type || options.contentType || 'application/octet-stream',
    size: blob.size,
    async *chunks(chunkBytes: number) {
      for (let offset = 0; offset < blob.size; offset += chunkBytes) {
        yield new Uint8Array(await blob.slice(offset, offset + chunkBytes).arrayBuffer());
      }
    },
    async cleanup() {},
  };
}
