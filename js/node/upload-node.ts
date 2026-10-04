import { createReadStream } from 'fs';
import { basename } from 'path';
import { Readable } from 'stream';
import { makeError } from '../src/errors.js';
import { requireSessionFileRef } from '../src/files.js';
import type { UploadInput } from '../src/upload.js';
import type { FetchFn } from '../src/types.js';

function resolveUploadFilename(file: UploadInput | Readable): string {
  if (typeof file === 'string') {
    const name = basename(file.trim());
    return name || 'upload';
  }
  const name = typeof file === 'object' && file !== null
    ? (file as { name?: unknown }).name
    : undefined;
  return typeof name === 'string' && name.trim() ? name : 'upload';
}

export async function uploadFileNode(
  file: UploadInput | Readable,
  accessToken: string,
  uploadUrl: string,
  fetchFn: FetchFn,
): Promise<string> {
  // Normalize to Buffer
  let buffer: Buffer;
  if (typeof file === 'string') {
    // file path
    buffer = await streamToBuffer(createReadStream(file));
  } else if (file instanceof Readable) {
    buffer = await streamToBuffer(file);
  } else if (file instanceof ArrayBuffer) {
    buffer = Buffer.from(file);
  } else if (typeof Blob !== 'undefined' && file instanceof Blob) {
    buffer = Buffer.from(await file.arrayBuffer());
  } else if (file instanceof Uint8Array) {
    buffer = Buffer.from(file);
  } else if (Buffer.isBuffer(file)) {
    buffer = file;
  } else {
    throw makeError('upload_type_rejected', 'Unsupported Node upload input');
  }

  // Use Node's FormData (available in Node 18+)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const formData = new (globalThis as any).FormData();
  const blob = new Blob([Uint8Array.from(buffer)]);
  formData.append('file', blob, resolveUploadFilename(file));

  const res = await fetchFn(uploadUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: formData,
  });

  if (!res.ok) {
    if (res.status === 413) throw makeError('upload_too_large', 'File exceeds the allowed size limit');
    if (res.status === 415) throw makeError('upload_type_rejected', 'File type not accepted');
    throw makeError('upload_failed', `Upload failed with status ${res.status}`);
  }

  const body = await res.json() as Record<string, unknown>;
  try {
    return requireSessionFileRef(body['file_ref'], 'Upload response file_ref');
  } catch {
    throw makeError('upload_failed', 'Upload response must include a canonical sf_ file_ref');
  }
}

function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
