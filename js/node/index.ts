import { Readable } from 'stream';
import { WebSocket } from 'ws';
import { CortexClient, type CortexClientPlatform } from '../src/client.js';
import type { UploadInput } from '../src/upload.js';
import { uploadFileNode } from './upload-node.js';
import type { CortexClientOptions, FetchFn, FormDataCtor } from '../src/types.js';

const UPLOAD_URL = '/upload';

// Node 18+ has global fetch; fall back to a minimal shim for older versions
const nodeFetch: FetchFn = (url, init) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).fetch(url, init);
};

// Node-compatible FormData (global in Node 18+)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NodeFormData: FormDataCtor = (globalThis as any).FormData;

function makePlatform(): CortexClientPlatform {
  return {
    WS: WebSocket as unknown as CortexClientPlatform['WS'],
    fetchFn: nodeFetch,
    FormDataClass: NodeFormData,
    uploadUrl: UPLOAD_URL,
  };
}

export class CortexNodeClient extends CortexClient {
  constructor(options: CortexClientOptions) {
    super(options, makePlatform());
  }

  /** Node-specific override: accepts browser-safe inputs plus file paths and Readable streams */
  async uploadFile(file: UploadInput | Readable, options: { sessionId?: string } = {}): Promise<string> {
    if (!this['_accessToken']) {
      const { makeError } = await import('../src/errors.js');
      throw makeError('auth_invalid', 'Not connected');
    }
    const sessionId = options.sessionId ?? this.sessionId;
    if (!sessionId) {
      const { makeError } = await import('../src/errors.js');
      throw makeError('session_not_ready', 'Session is not ready');
    }
    const runtimeBaseUrl = this['_requireRuntimeHttpBaseUrl']() as string;
    const uploadUrl = new URL(UPLOAD_URL, `${runtimeBaseUrl}/`);
    uploadUrl.searchParams.set('session_id', sessionId);
    return uploadFileNode(
      file,
      this['_accessToken'] as string,
      uploadUrl.toString(),
      nodeFetch,
    );
  }

  async uploadAttachment(file: UploadInput | Readable): Promise<string> {
    return this.uploadFile(file);
  }
}

// Re-export as CortexClient for uniform import
export { CortexNodeClient as CortexClient };
export type {
  CortexClientOptions,
  CortexMessage,
  EscalationReplyAction,
  EscalationReplyContent,
  SessionState,
  ReplyEscalationOptions,
  ChannelState,
  SendMessageOptions,
  FileScope,
  FileRef,
  FileListResult,
  FileReadyEvent,
  UploadFileOptions,
  DownloadFileOptions,
  ListFilesOptions,
  PromoteFileOptions,
  SessionFileAttachment,
  SessionFileAttachmentInput,
} from '../src/types.js';
export { CortexError } from '../src/errors.js';
