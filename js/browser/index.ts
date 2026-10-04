import { CortexClient, type CortexClientPlatform } from '../src/client.js';
import type { CortexClientOptions } from '../src/types.js';

function makePlatform(_options: CortexClientOptions): CortexClientPlatform {
  return {
    WS: WebSocket as unknown as CortexClientPlatform['WS'],
    fetchFn: (url, init) => fetch(url, init as RequestInit) as Promise<import('../src/types.js').Response>,
  };
}

export class CortexBrowserClient extends CortexClient {
  constructor(options: CortexClientOptions) {
    super(options, makePlatform(options));
  }
}

// Re-export as CortexClient for uniform import
export { CortexBrowserClient as CortexClient };
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
