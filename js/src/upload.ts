import { makeError } from './errors.js';
import { requireSessionFileRef } from './files.js';
import type { FetchFn, FormDataCtor } from './types.js';

export type UploadInput = Blob | ArrayBuffer | string | Uint8Array;

function resolveUploadFilename(file: unknown): string {
  const name = typeof file === 'object' && file !== null
    ? (file as { name?: unknown }).name
    : undefined;
  return typeof name === 'string' && name.trim() ? name : 'upload';
}

export async function uploadFile(
  file: UploadInput,
  accessToken: string,
  uploadUrl: string,
  fetchFn: FetchFn,
  FormDataClass: FormDataCtor,
): Promise<string> {
  const formData = new FormDataClass();

  // Normalize to Blob-like for append
  let blob: Blob;
  if (typeof file === 'string') {
    // file path — only valid in Node.js entry; browser entry shouldn't hit this
    throw new Error('File path upload is not supported in browser entry — use Blob or ArrayBuffer');
  } else if (file instanceof ArrayBuffer) {
    blob = new Blob([file]);
  } else if (ArrayBuffer.isView(file)) {
    blob = new Blob([file.buffer as ArrayBuffer]);
  } else {
    blob = file as Blob;
  }

  formData.append('file', blob, resolveUploadFilename(file));

  const res = await fetchFn(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      // Content-Type is set automatically with boundary when using FormData
    },
    body: formData as unknown as Uint8Array, // fetchFn accepts FormData via unknown cast
  });

  if (!res.ok) {
    if (res.status === 413) {
      throw makeError('upload_too_large', 'File exceeds the allowed size limit');
    }
    if (res.status === 415) {
      throw makeError('upload_type_rejected', 'File type not accepted by the runtime');
    }
    throw makeError('upload_failed', `Upload failed with status ${res.status}`);
  }

  const body = await res.json() as Record<string, unknown>;
  try {
    return requireSessionFileRef(body['file_ref'], 'Upload response file_ref');
  } catch {
    throw makeError('upload_failed', 'Upload response must include a canonical sf_ file_ref');
  }
}
