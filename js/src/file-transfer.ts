import { SCHEMA_VERSION } from './constants.js';
import { makeError } from './errors.js';
import { parsePublicFileList, requireSessionFileRef } from './files.js';
import type { FileListResult, CortexMessage } from './types.js';
import type { Transport } from './transport.js';

const MAGIC = new Uint8Array([0x43, 0x46, 0x54, 0x31]);
const HEADER_BYTES = 24;
const TRANSFER_ID = /^ft_[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FORBIDDEN_KEYS = new Set(['file_id', 'snapshot_id', 'blob_ref', 'storage_key', 'ticket', 'upload_ticket', 'delivery_ticket', 'file_link_secret', 'instance_id']);
const FILE_RESPONSE_TYPES = new Set(['file::upload.ready', 'file::upload.complete', 'file::download.ready', 'file::download.complete', 'file::list.result']);

export interface UploadSource {
  filename: string;
  contentType: string;
  size: number;
  chunks(chunkBytes: number): AsyncIterable<Uint8Array>;
  cleanup(): Promise<void>;
}

interface PendingRequest {
  expectedType: string;
  transferId?: string;
  resolve: (message: CortexMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onResponse?: (message: CortexMessage) => void;
}

interface DownloadState {
  expectedSequence: number;
  declaredSize: number;
  receivedSize: number;
  chunks: Uint8Array[];
  contentType: string;
  completeReceived: boolean;
  resolve: (value: Blob) => void;
  reject: (error: Error) => void;
}

export function encodeCft1(transferId: string, sequence: number, payload: Uint8Array): Uint8Array {
  if (!TRANSFER_ID.test(transferId)) throw makeError('invalid_file_transfer', 'Invalid CFT1 transfer_id');
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff) throw makeError('invalid_file_transfer', 'Invalid CFT1 sequence');
  const frame = new Uint8Array(HEADER_BYTES + payload.byteLength);
  frame.set(MAGIC, 0);
  for (let index = 0; index < 16; index++) frame[4 + index] = Number.parseInt(transferId.slice(3 + index * 2, 5 + index * 2), 16);
  new DataView(frame.buffer).setUint32(20, sequence, false);
  frame.set(payload, HEADER_BYTES);
  return frame;
}

export function decodeCft1(frame: Uint8Array): { transferId: string; sequence: number; payload: Uint8Array } {
  if (frame.byteLength < HEADER_BYTES) throw makeError('invalid_file_transfer', 'CFT1 frame is shorter than its header');
  if (!MAGIC.every((value, index) => frame[index] === value)) throw makeError('invalid_file_transfer', 'Invalid CFT1 magic');
  let hex = '';
  for (const value of frame.subarray(4, 20)) hex += value.toString(16).padStart(2, '0');
  return { transferId: `ft_${hex}`, sequence: new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(20, false), payload: frame.subarray(HEADER_BYTES) };
}

export class FileTransferManager {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly uploads = new Map<string, Error | null>();
  private readonly downloads = new Map<string, DownloadState>();

  constructor(private readonly transport: Transport, private readonly sendTimeoutMs: number) {}

  async upload(sessionId: string, source: UploadSource, sha256?: string): Promise<string> {
    if (sha256 !== undefined && !SHA256.test(sha256)) throw makeError('invalid_file_transfer', 'sha256 must be 64 lowercase hex characters');
    let activeTransferId: string | undefined;
    try {
      const payload: Record<string, unknown> = { filename: source.filename, content_type: source.contentType, size: source.size };
      if (sha256) payload['sha256'] = sha256;
      const ready = await this.request(sessionId, 'file::upload.prepare', 'file::upload.ready', payload);
      assertSafePublicControl(ready.payload);
      const transferId = requireTransferId(ready.payload['transfer_id']);
      activeTransferId = transferId;
      const chunkBytes = requirePositiveInteger(ready.payload['chunk_bytes'], 'chunk_bytes');
      const maxBytes = requirePositiveInteger(ready.payload['max_bytes'], 'max_bytes');
      if (source.size > 0 && chunkBytes > maxBytes) throw makeError('invalid_file_transfer', 'chunk_bytes exceeds max_bytes');
      if (source.size > maxBytes) throw makeError('file_too_large', 'File exceeds server max_bytes');
      this.uploads.set(transferId, null);
      let sequence = 0;
      for await (const chunk of source.chunks(chunkBytes)) {
        this.throwUploadError(transferId);
        if (chunk.byteLength === 0) continue;
        if (sequence > 0xffffffff) throw makeError('invalid_file_transfer', 'CFT1 sequence overflow');
        await this.transport.sendBinary(encodeCft1(transferId, sequence, chunk), this.sendTimeoutMs);
        this.throwUploadError(transferId);
        sequence++;
      }
      this.throwUploadError(transferId);
      const complete = await this.request(sessionId, 'file::upload.commit', 'file::upload.complete', { transfer_id: transferId }, transferId);
      assertSafePublicControl(complete.payload);
      if (requireTransferId(complete.payload['transfer_id']) !== transferId) throw makeError('invalid_file_transfer', 'Upload completion transfer_id mismatch');
      return requireSessionFileRef(complete.payload['file_ref'], 'Upload completion file_ref');
    } finally {
      if (activeTransferId) this.uploads.delete(activeTransferId);
      await source.cleanup();
    }
  }

  async download(sessionId: string, fileRef: string): Promise<Blob> {
    let resolveDownload!: (value: Blob) => void;
    let rejectDownload!: (error: Error) => void;
    const result = new Promise<Blob>((resolve, reject) => { resolveDownload = resolve; rejectDownload = reject; });
    await this.request(
      sessionId,
      'file::download.prepare',
      'file::download.ready',
      { file_ref: requireSessionFileRef(fileRef) },
      undefined,
      (ready) => {
        assertSafePublicControl(ready.payload);
        const transferId = requireTransferId(ready.payload['transfer_id']);
        const size = requireNonNegativeInteger(ready.payload['size'], 'size');
        requirePositiveInteger(ready.payload['chunk_bytes'], 'chunk_bytes');
        const contentType = typeof ready.payload['content_type'] === 'string' ? ready.payload['content_type'] : 'application/octet-stream';
        this.downloads.set(transferId, { expectedSequence: 0, declaredSize: size, receivedSize: 0, chunks: [], contentType, completeReceived: false, resolve: resolveDownload, reject: rejectDownload });
      },
    );
    return result;
  }

  async list(sessionId: string): Promise<FileListResult> {
    const result = await this.request(sessionId, 'file::list', 'file::list.result', {});
    assertSafePublicControl(result.payload);
    return parsePublicFileList(result.payload);
  }

  handleMessage(message: CortexMessage): boolean {
    if (FILE_RESPONSE_TYPES.has(message.type)) {
      try {
        assertSafePublicControl(message.payload);
        if (message.type === 'file::download.complete') { this.handleDownloadComplete(message.payload); return true; }
        const clientMsgId = message.meta?.['client_msg_id'];
        if (typeof clientMsgId !== 'string') throw makeError('invalid_file_transfer', `${message.type} missing meta.client_msg_id`);
        const pending = this.pending.get(clientMsgId);
        if (!pending || pending.expectedType !== message.type) throw makeError('invalid_file_transfer', `Uncorrelated ${message.type}`);
        pending.onResponse?.(message);
        this.pending.delete(clientMsgId);
        clearTimeout(pending.timer);
        pending.resolve(message);
      } catch (error) { this.rejectRelevant(message, asError(error)); }
      return true;
    }
    if (message.type !== 'system::error') return false;
    const clientMsgId = message.meta?.['client_msg_id'];
    const transferId = message.payload['transfer_id'];
    const pending = typeof clientMsgId === 'string' ? this.pending.get(clientMsgId) : undefined;
    const hasTransfer = typeof transferId === 'string' && (this.uploads.has(transferId) || this.downloads.has(transferId));
    if (!pending && !hasTransfer) return false;
    if (pending?.transferId && transferId !== undefined && pending.transferId !== transferId) {
      pending.reject(makeError('invalid_file_transfer', 'Error correlation fields disagree'));
      return true;
    }
    const code = typeof message.payload['code'] === 'string' ? message.payload['code'] : 'invalid_file_transfer';
    const text = typeof message.payload['message'] === 'string' ? message.payload['message'] : 'File operation failed';
    const error = makeError(code, text);
    if (pending && typeof clientMsgId === 'string') { this.pending.delete(clientMsgId); clearTimeout(pending.timer); pending.reject(error); }
    if (typeof transferId === 'string') this.rejectTransfer(transferId, error);
    return true;
  }

  handleBinary(frame: Uint8Array): void {
    let decoded: ReturnType<typeof decodeCft1>;
    try { decoded = decodeCft1(frame); } catch { return; }
    const state = this.downloads.get(decoded.transferId);
    if (!state) return;
    if (decoded.sequence !== state.expectedSequence) { this.rejectTransfer(decoded.transferId, makeError('invalid_file_transfer', 'Download sequence mismatch')); return; }
    if (state.receivedSize + decoded.payload.byteLength > state.declaredSize) { this.rejectTransfer(decoded.transferId, makeError('file_download_failed', 'Download exceeds declared size')); return; }
    state.chunks.push(decoded.payload.slice());
    state.receivedSize += decoded.payload.byteLength;
    state.expectedSequence++;
    this.finishDownloadIfReady(decoded.transferId, state);
  }

  abortAll(): void {
    const error = makeError('file_transfer_interrupted', 'File transfer interrupted by connection close');
    for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(error); this.pending.delete(id); }
    for (const id of Array.from(this.downloads.keys())) this.rejectTransfer(id, error);
    this.uploads.clear();
  }

  private request(sessionId: string, type: string, expectedType: string, payload: Record<string, unknown>, transferId?: string, onResponse?: (message: CortexMessage) => void): Promise<CortexMessage> {
    const clientMsgId = makeClientMsgId(type);
    const response = new Promise<CortexMessage>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(clientMsgId); reject(makeError('file_transport_unavailable', `${type} response timed out`)); }, this.sendTimeoutMs);
      this.pending.set(clientMsgId, { expectedType, transferId, resolve, reject, timer, onResponse });
    });
    const envelope = { type, schema: SCHEMA_VERSION, session_id: sessionId, payload, meta: { client_msg_id: clientMsgId }, ts: new Date().toISOString() };
    void this.transport.sendJson(envelope, this.sendTimeoutMs).catch((error) => {
      const pending = this.pending.get(clientMsgId);
      if (!pending) return;
      this.pending.delete(clientMsgId); clearTimeout(pending.timer); pending.reject(asError(error));
    });
    return response;
  }

  private handleDownloadComplete(payload: Record<string, unknown>): void {
    const transferId = requireTransferId(payload['transfer_id']);
    const state = this.downloads.get(transferId);
    if (!state) return;
    state.completeReceived = true;
    this.finishDownloadIfReady(transferId, state);
  }

  private finishDownloadIfReady(transferId: string, state: DownloadState): void {
    if (!state.completeReceived) return;
    if (state.receivedSize !== state.declaredSize) { this.rejectTransfer(transferId, makeError('file_download_failed', 'Download size mismatch')); return; }
    this.downloads.delete(transferId);
    state.resolve(new Blob(state.chunks.map((chunk) => Uint8Array.from(chunk).buffer), { type: state.contentType }));
  }

  private rejectRelevant(message: CortexMessage, error: Error): void {
    const clientMsgId = message.meta?.['client_msg_id'];
    if (typeof clientMsgId === 'string') {
      const pending = this.pending.get(clientMsgId);
      if (pending) { this.pending.delete(clientMsgId); clearTimeout(pending.timer); pending.reject(error); }
    }
    const transferId = message.payload['transfer_id'];
    if (typeof transferId === 'string') this.rejectTransfer(transferId, error);
  }

  private rejectTransfer(transferId: string, error: Error): void {
    const download = this.downloads.get(transferId);
    if (download) { this.downloads.delete(transferId); download.reject(error); }
    if (this.uploads.has(transferId)) this.uploads.set(transferId, error);
    for (const [clientMsgId, pending] of this.pending) {
      if (pending.transferId === transferId) {
        this.pending.delete(clientMsgId);
        clearTimeout(pending.timer);
        pending.reject(error);
      }
    }
  }

  private throwUploadError(transferId: string): void {
    const error = this.uploads.get(transferId);
    if (error) throw error;
  }
}

export function assertSafePublicControl(value: unknown): void {
  if (typeof value === 'string') { if (value.startsWith('fi_')) throw makeError('invalid_file_transfer', 'Internal File Layer identity leaked'); return; }
  if (Array.isArray(value)) { value.forEach(assertSafePublicControl); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) throw makeError('invalid_file_transfer', `Forbidden public field: ${key}`);
    assertSafePublicControl(nested);
  }
}

function requireTransferId(value: unknown): string {
  if (typeof value !== 'string' || !TRANSFER_ID.test(value)) throw makeError('invalid_file_transfer', 'Invalid transfer_id');
  return value;
}
function requirePositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw makeError('invalid_file_transfer', `${name} must be a positive integer`);
  return value as number;
}
function requireNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw makeError('invalid_file_transfer', `${name} must be a non-negative integer`);
  return value as number;
}
function makeClientMsgId(type: string): string { return `cli_file_${type.replace(/[^a-z]+/g, '_')}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`; }
function asError(value: unknown): Error { return value instanceof Error ? value : makeError('invalid_file_transfer', String(value)); }
