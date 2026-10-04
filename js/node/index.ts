import { Readable } from 'stream';
import { WebSocket } from 'ws';
import { CortexClient, type CortexClientPlatform } from '../src/client.js';
import type { UploadInput } from '../src/upload.js';
import { createNodeUploadSource } from './upload-node.js';
import type { CortexClientOptions, FetchFn, UploadFileOptions } from '../src/types.js';

// Node 18+ has global fetch; fall back to a minimal shim for older versions
const nodeFetch: FetchFn = (url, init) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).fetch(url, init);
};

function makePlatform(_options: CortexClientOptions): CortexClientPlatform {
  return {
    WS: WebSocket as unknown as CortexClientPlatform['WS'],
    fetchFn: nodeFetch,
  };
}

export class CortexNodeClient extends CortexClient {
  constructor(options: CortexClientOptions) {
    super(options, makePlatform(options));
  }

  /** Node-specific override: accepts browser-safe inputs plus file paths and Readable streams */
  async uploadFile(file: UploadInput | Readable, options: UploadFileOptions = {}): Promise<string> {
    return this._uploadSessionSource(await createNodeUploadSource(file, options), options);
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
