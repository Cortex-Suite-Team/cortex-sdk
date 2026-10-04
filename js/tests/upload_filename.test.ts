import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadFile } from '../src/upload.js';
import { uploadFileNode } from '../node/upload-node.js';
import type { FetchFn, FormDataCtor } from '../src/types.js';

type CapturedAppend = {
  name: string;
  value: Blob | string;
  filename?: string;
};

class CapturingFormData {
  entries: CapturedAppend[] = [];

  append(name: string, value: Blob | string, filename?: string): void {
    this.entries.push({ name, value, filename });
  }
}

function makeOkFetch(): FetchFn {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ file_ref: 'sf_test' }),
  });
}

function requireCaptured(formData: CapturingFormData | null): CapturingFormData {
  expect(formData).not.toBeNull();
  if (formData === null) {
    throw new Error('expected captured FormData append');
  }
  return formData;
}

describe('upload filename preservation', () => {
  it('preserves a browser-side structural file.name in multipart upload', async () => {
    let captured: CapturingFormData | null = null;
    class BrowserFormData extends CapturingFormData {
      constructor() {
        super();
        captured = this;
      }
    }

    const file = Object.assign(new Blob(['hello']), { name: 'example.md' });
    const fileRef = await uploadFile(
      file,
      'token',
      '/upload',
      makeOkFetch(),
      BrowserFormData as unknown as FormDataCtor,
    );

    expect(fileRef).toBe('sf_test');
    const formData = requireCaptured(captured);
    expect(formData.entries).toHaveLength(1);
    expect(formData.entries[0]).toMatchObject({
      name: 'file',
      filename: 'example.md',
    });
  });

  it('falls back to upload when browser input has no structural name', async () => {
    let captured: CapturingFormData | null = null;
    class BrowserFormData extends CapturingFormData {
      constructor() {
        super();
        captured = this;
      }
    }

    await uploadFile(
      new Uint8Array([1, 2, 3]),
      'token',
      '/upload',
      makeOkFetch(),
      BrowserFormData as unknown as FormDataCtor,
    );

    expect(requireCaptured(captured).entries[0]?.filename).toBe('upload');
  });

  it('preserves a structural name in the node upload entrypoint', async () => {
    const originalFormData = (globalThis as Record<string, unknown>).FormData;
    let captured: CapturingFormData | null = null;
    class NodeFormData extends CapturingFormData {
      constructor() {
        super();
        captured = this;
      }
    }

      Object.defineProperty(globalThis, 'FormData', {
        configurable: true,
        value: NodeFormData,
      });

    try {
      const file = Object.assign(new Blob(['hello']), { name: 'node-report.txt' });
      const fileId = await uploadFileNode(file, 'token', '/upload', async () => ({
        ok: true,
        status: 200,
        json: async () => ({ file_ref: 'sf_test' }),
      }));

      expect(fileId).toBe('sf_test');
      expect(requireCaptured(captured).entries[0]?.filename).toBe('node-report.txt');
    } finally {
      Object.defineProperty(globalThis, 'FormData', {
        configurable: true,
        value: originalFormData,
      });
    }
  });

  it('uses the basename for a node path upload', async () => {
    const originalFormData = (globalThis as Record<string, unknown>).FormData;
    let captured: CapturingFormData | null = null;
    class NodeFormData extends CapturingFormData {
      constructor() {
        super();
        captured = this;
      }
    }

    Object.defineProperty(globalThis, 'FormData', {
      configurable: true,
      value: NodeFormData,
    });

    const tempDir = await mkdtemp(join(tmpdir(), 'cortex-sdk-upload-'));
    const filePath = join(tempDir, 'invoice.pdf');

    try {
      await writeFile(filePath, 'hello');
      await uploadFileNode(filePath, 'token', '/upload', async () => ({
        ok: true,
        status: 200,
        json: async () => ({ file_ref: 'sf_test' }),
      }));

      expect(requireCaptured(captured).entries[0]?.filename).toBe('invoice.pdf');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      Object.defineProperty(globalThis, 'FormData', {
        configurable: true,
        value: originalFormData,
      });
    }
  });

  it.each([
    [{ file_id: 'fi_test' }],
    [{ attachment_id: 'fa_test' }],
    [{ file_ref: 'fi_test' }],
    [{}],
  ])('rejects a non-canonical browser upload response: %p', async (body) => {
    await expect(uploadFile(
      new Uint8Array([1]),
      'token',
      '/upload',
      async () => ({ ok: true, status: 200, json: async () => body }),
      CapturingFormData as unknown as FormDataCtor,
    )).rejects.toMatchObject({ code: 'upload_failed' });
  });

  it('rejects a legacy-only node upload response', async () => {
    await expect(uploadFileNode(
      new Uint8Array([1]),
      'token',
      '/upload',
      async () => ({ ok: true, status: 200, json: async () => ({ file_id: 'fi_test' }) }),
    )).rejects.toMatchObject({ code: 'upload_failed' });
  });
});
