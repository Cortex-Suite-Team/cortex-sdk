export interface CortexClientOptions {
  apiKey: string;
  workerRef?: string;
  /**
   * Base URL of the Cortex auth service — origin only, no path component.
   * The SDK appends `/auth/token` and `/auth/refresh` automatically.
   * @example "https://cortexsuite.app"
   * @default "https://cortexsuite.app"
   */
  authUrl?: string;
  /** Override the SessionManager upload endpoint. Relative paths resolve against the runtime origin. */
  uploadUrl?: string;
  onMessage: (message: CortexMessage) => void;
  connectTimeout?: number;
  sessionOpenTimeout?: number;
  sendTimeout?: number;
  resyncTimeout?: number;
  pingInterval?: number;
  pongTimeout?: number;
  staleThreshold?: number;
  /** Internal/debug use only. Disabled by default. */
  debug?: boolean;
}

export interface CortexMessage {
  type: string;
  schema: string;
  session_id?: string;
  seq?: number;
  payload: Record<string, unknown>;
  meta?: Record<string, unknown>;
  ts: string;
}

export type SessionState =
  | 'CREATED'
  | 'INITIALIZING'
  | 'ACTIVE'
  | 'WAITING'
  | 'COMPLETED'
  | 'FAILED'
  | 'STOPPED'
  | 'TIMEOUT'
  | 'CANCELLED';

export type ChannelState =
  | 'CONNECTING'
  | 'OPEN'
  | 'STALE'
  | 'RECONNECTING'
  | 'CLOSED'
  | 'AUTH_FAILED';

export interface NormalAuthTokenResponse {
  auth_required?: false;
  ws_url: string;
  access_token: string;
  refresh_token: string;
  cp_api_url?: string | null;
  runtime_bootstrap: RuntimeBootstrap;
}

export interface AuthRequiredTokenResponse {
  auth_required: true;
  ws_url: string;
  access_token: string;
  refresh_token: string;
  cp_api_url?: string | null;
  auth?: { type: 'system::auth'; payload: Record<string, unknown> };
}

export type AuthTokenResponse = NormalAuthTokenResponse | AuthRequiredTokenResponse;

export type FileScope = 'session' | 'project';

export interface FileRef {
  file_ref: string;
  filename?: string;
  content_type?: string;
  size?: number;
  scope_type?: string;
  scope_id?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
  expires_at?: string | null;
}

export interface FileListResult {
  files: FileRef[];
  total: number;
}

export interface FileReadyEvent extends FileRef {
  file_ref: string;
}

export interface SessionFileAttachment {
  file_ref: string;
  filename?: string;
  content_type?: string;
  size?: number;
}

export type SessionFileAttachmentInput = string | SessionFileAttachment;

export interface UploadFileOptions {
  sessionId?: string;
}

export interface DownloadFileOptions {
  scope?: FileScope;
  sessionId?: string;
  projectId?: string | number;
}

export interface ListFilesOptions {
  scope?: FileScope;
  sessionId?: string;
  projectId?: string | number;
  limit?: number;
  offset?: number;
  includeTrashed?: boolean;
}

export interface PromoteFileOptions {
  projectId: string | number;
}

export interface RuntimeBootstrap {
  execution_mode: string;
  bundle_url: string;
  checksum: string;
  artifact_id?: string;
  artifact_kind?: string;
  run_mode?: string;
  session_context?: Record<string, unknown>;
  trigger_payload?: Record<string, unknown>;
}

export interface SessionIdentityContext {
  tenantId: string | null;
  projectId: string | null;
  deploymentId: string | null;
  releaseId: string | null;
  userId: string | null;
  userUuid: string | null;
  actorKind: string | null;
  actorRef: string | null;
}

export interface SessionCorrespondentContext {
  kind?: string | null;
  id?: string | null;
  name: string;
  title?: string | null;
  subtitle?: string | null;
  avatarUrl?: string | null;
}

export interface SessionContext {
  sessionId: string;
  status: string;
  executionMode: string;
  artifactId: string | null;
  artifactKind: string | null;
  runMode: string | null;
  identity: SessionIdentityContext | null;
  correspondent: SessionCorrespondentContext | null;
}

export interface SendMessageOptions {
  content: unknown;
  attachments?: SessionFileAttachmentInput[];
  meta?: Record<string, unknown>;
}

export type EscalationReplyAction =
  | 'continue'
  | 'operator_input'
  | 'reply_user';

export type EscalationReplyContent = string | Record<string, unknown>;

export interface ReplyEscalationOptions {
  escalationId: string;
  waitToken: string;
  action: EscalationReplyAction;
  content?: EscalationReplyContent;
  meta?: Record<string, unknown>;
}

/** Transient UI state emitted by SessionManager. Never stored in transcript. */
export interface SystemStateMessage {
  type: 'system::state';
  payload: {
    content: string[];
    meta: {
      state: 'working' | 'waiting' | 'idle' | 'error';
      label?: string;
      ttl_ms?: number;
      correlation_id?: string;
    };
  };
}

/** Platform-specific WebSocket constructor passed in by each entry point. */
export type WebSocketCtor = new (url: string, protocols: string[]) => WebSocketLike;

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string | Buffer }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
}

/** Platform-specific fetch function passed in by each entry point. */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface RequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | FormData | Uint8Array;
}

export interface Response {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer?(): Promise<ArrayBuffer>;
  blob?(): Promise<Blob>;
}

/** FormData-like interface (browser FormData or node-compatible). */
export interface FormDataLike {
  append(name: string, value: Blob | string, filename?: string): void;
}
export type FormDataCtor = new () => FormDataLike;
