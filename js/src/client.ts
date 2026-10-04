import {
  DEFAULT_AUTH_URL,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_SESSION_OPEN_TIMEOUT_MS,
  DEFAULT_SEND_TIMEOUT_MS,
  DEFAULT_RESYNC_TIMEOUT_MS,
  DEFAULT_PING_INTERVAL_MS,
  DEFAULT_PONG_TIMEOUT_MS,
  DEFAULT_STALE_THRESHOLD_MS,
  RECONNECT_BACKOFF_MS,
  TOKEN_REFRESH_BUFFER_MS,
} from './constants.js';
import { makeError } from './errors.js';
import { ensureFrontendUuid } from './frontend-uuid.js';
import {
  exchangeApiKey,
  refreshAccessToken,
  isTokenExpiringSoon,
  normalizeAuthBaseUrl,
} from './auth.js';
import { debugLog, readSdkDebugFlag } from './debug.js';
import { createTransport } from './transport.js';
import { createLiveness } from './liveness.js';
import { createSession } from './session.js';
import { createUploadSource, type UploadInput } from './upload.js';
import { FileTransferManager, type UploadSource } from './file-transfer.js';
import { parsePublicFileList, parsePublicFileRef, requireSessionFileRef } from './files.js';
import type {
  CortexClientOptions,
  CortexMessage,
  SessionState,
  ChannelState,
  ReplyEscalationOptions,
  WebSocketCtor,
  FetchFn,
  DownloadFileOptions,
  FileListResult,
  FileRef,
  ListFilesOptions,
  PromoteFileOptions,
  SessionContext,
  UploadFileOptions,
  NormalAuthTokenResponse,
  SendMessageOptions,
} from './types.js';

export interface CortexClientPlatform {
  WS: WebSocketCtor;
  fetchFn: FetchFn;
}

function summarizeSendPayload(payload: {
  content?: unknown;
  attachments?: unknown[];
  meta?: Record<string, unknown>;
}) {
  return {
    contentKind: Array.isArray(payload.content) ? 'array' : typeof payload.content,
    contentLength: Array.isArray(payload.content) ? payload.content.length : undefined,
    hasAttachments: Boolean(payload.attachments?.length),
    attachmentCount: payload.attachments?.length ?? 0,
    metaKeys: payload.meta ? Object.keys(payload.meta) : [],
    clientMsgId:
      payload.meta && typeof payload.meta.client_msg_id === 'string'
        ? payload.meta.client_msg_id
        : undefined,
  };
}

export class CortexClient {
  private readonly _options:
    Required<Omit<CortexClientOptions, 'apiKey' | 'onMessage' | 'workerRef'>>
    & Pick<CortexClientOptions, 'apiKey' | 'onMessage' | 'workerRef'>;
  private readonly _platform: CortexClientPlatform;
  private readonly _messageHandlers = new Set<(message: CortexMessage) => void>();

  private _channelState: ChannelState = 'CLOSED';
  private _accessToken: string | null = null;
  private _refreshToken: string | null = null;
  private _wsUrl: string | null = null;
  private _cpApiUrl: string | null = null;
  private _sessionMeta: Record<string, unknown> | null = null;
  private _sessionContext: SessionContext | null = null;
  private _bootstrapMeta: Record<string, unknown> | null = null;
  private _authRequired = false;
  private _channelId = `ch_${Math.random().toString(36).slice(2, 10)}`;
  private _reconnectAttempt = 0;
  private _disconnectRequested = false;
  private _debugEnabled = false;
  private _connectPromise: Promise<void> | null = null;
  private _sessionOpenWaiter: Deferred<void> | null = null;
  private _sessionOpenTimer: ReturnType<typeof setTimeout> | null = null;
  private _suppressNextReconnect = false;

  private readonly _transport;
  private readonly _session;
  private readonly _fileTransfers;
  private _liveness: ReturnType<typeof createLiveness> | null = null;
  private _tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _pendingDelayCancels = new Set<() => void>();
  private _reconnectLoopPromise: Promise<void> | null = null;

  constructor(options: CortexClientOptions, platform: CortexClientPlatform) {
    const authUrl = normalizeAuthBaseUrl(options.authUrl ?? DEFAULT_AUTH_URL);
    this._options = {
      connectTimeout: DEFAULT_CONNECT_TIMEOUT_MS,
      sessionOpenTimeout: DEFAULT_SESSION_OPEN_TIMEOUT_MS,
      sendTimeout: DEFAULT_SEND_TIMEOUT_MS,
      resyncTimeout: DEFAULT_RESYNC_TIMEOUT_MS,
      pingInterval: DEFAULT_PING_INTERVAL_MS,
      pongTimeout: DEFAULT_PONG_TIMEOUT_MS,
      staleThreshold: DEFAULT_STALE_THRESHOLD_MS,
      debug: false,
      ...options,
      authUrl,
    };
    this._platform = platform;

    this._debugEnabled = options.debug === true || readSdkDebugFlag();
    this._transport = createTransport(platform.WS, this._options.connectTimeout, () => this._debugEnabled);
    this._session = createSession({
      onMessage: (msg) => this._handleSessionMessage(msg),
      onFatalError: (err) => this._handleSessionFatalError(err),
    });
    this._fileTransfers = new FileTransferManager(this._transport, this._options.sendTimeout);

    this._transport.onText = (data) => {
      let message: CortexMessage;
      try { message = JSON.parse(data) as CortexMessage; } catch { return; }
      if (!this._fileTransfers.handleMessage(message)) this._session.handleMessage(message);
    };
    this._transport.onBinary = (data) => this._fileTransfers.handleBinary(data);
    this._transport.onClose = (code, reason) => this._handleClose(code, reason);
    this._transport.onError = () => { /* handled via onClose */ };
  }

  get sessionState(): SessionState { return this._session.sessionState; }
  get channelState(): ChannelState { return this._channelState; }
  get sessionId(): string | null { return this._session.sessionId; }
  get sessionMeta(): Record<string, unknown> | null { return this._sessionMeta; }
  get sessionContext(): SessionContext | null { return this._sessionContext; }
  get accessToken(): string | null { return this._accessToken; }
  get cpApiUrl(): string | null { return this._cpApiUrl; }

  onMessage(handler: (message: CortexMessage) => void): () => void {
    this._messageHandlers.add(handler);
    return () => {
      this._messageHandlers.delete(handler);
    };
  }

  connect(): Promise<void> {
    if (this._isSessionReady()) {
      return Promise.resolve();
    }
    if (this._connectPromise) {
      return this._connectPromise;
    }

    this._connectPromise = this._connectInternal()
      .catch((error) => {
        this._cleanupFailedConnect();
        throw error;
      })
      .finally(() => {
        this._connectPromise = null;
      });
    return this._connectPromise;
  }

  async disconnect(): Promise<void> {
    this._disconnectRequested = true;
    this._stopBackgroundActivity();
    this._fileTransfers.abortAll();
    this._resetConnectionRuntimeState();
    this._transport.close();
  }

  async sendMessage(options: SendMessageOptions): Promise<void> {
    debugLog(this._debugEnabled, '[sdk] CortexClient.sendMessage start', summarizeSendPayload(options));
    this._requireActiveSessionId();
    await this._session.sendChatMessage(options.content, options.attachments, options.meta);
    debugLog(this._debugEnabled, '[sdk] CortexClient.sendMessage done');
  }

  async sendLogin(credentials: { login: string; password: string }): Promise<void> {
    await this._session.sendSystemLogin(credentials.login, credentials.password);
  }

  setDebugLoggingEnabled(enabled: boolean): void {
    this._debugEnabled = enabled || readSdkDebugFlag();
  }

  async replyEscalation(options: ReplyEscalationOptions): Promise<void> {
    this._requireActiveSessionId();
    await this._session.sendEscalationReply(
      options.escalationId,
      options.waitToken,
      options.action,
      options.content,
      options.meta,
    );
  }

  async uploadFile(file: UploadInput, options: UploadFileOptions = {}): Promise<string> {
    return this._uploadSessionSource(createUploadSource(file, options), options);
  }

  async uploadAttachment(file: UploadInput): Promise<string> {
    return this.uploadFile(file);
  }

  async downloadFile(fileRef: string, options: DownloadFileOptions = {}): Promise<Blob> {
    if (!this._accessToken) throw makeError('auth_invalid', 'Not connected');
    const canonicalFileRef = requireSessionFileRef(fileRef);
    const scope = options.scope ?? 'session';
    if (scope === 'session') {
      return this._fileTransfers.download(this._requireActiveSessionId(options.sessionId), canonicalFileRef);
    }
    let url: string;
    if (scope === 'project') {
      if (options.projectId === undefined) {
        throw makeError('file_operation_failed', 'projectId is required for project file download');
      }
      url = `${this._requireCpApiUrl()}/api/workspace/projects/${encodeURIComponent(String(options.projectId))}`
        + `/files/${encodeURIComponent(canonicalFileRef)}/download/`;
    } else {
      throw makeError('file_operation_failed', `Unsupported file scope: ${scope}`);
    }

    const res = await this._request(url, 'GET');
    if (typeof res.blob === 'function') {
      return res.blob();
    }
    if (typeof res.arrayBuffer === 'function') {
      return new Blob([await res.arrayBuffer()]);
    }
    throw makeError('file_operation_failed', 'File API response does not expose bytes');
  }

  async listFiles(options: ListFilesOptions = {}): Promise<FileListResult> {
    if (!this._accessToken) throw makeError('auth_invalid', 'Not connected');
    const scope = options.scope ?? 'session';
    if (scope === 'session') return this._fileTransfers.list(this._requireActiveSessionId(options.sessionId));
    const query = {
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
      include_trashed: String(options.includeTrashed ?? false),
    };
    let url: string;
    if (scope === 'project') {
      if (options.projectId === undefined) {
        throw makeError('file_operation_failed', 'projectId is required for project file list');
      }
      url = `${this._requireCpApiUrl()}/api/workspace/projects/${encodeURIComponent(String(options.projectId))}/files/`;
    } else {
      throw makeError('file_operation_failed', `Unsupported file scope: ${scope}`);
    }

    const body = await this._requestJson(withQueryParams(url, query));
    return parsePublicFileList(body);
  }

  async promoteFile(fileRef: string, options: PromoteFileOptions): Promise<FileRef> {
    if (!this._accessToken) throw makeError('auth_invalid', 'Not connected');
    const canonicalFileRef = requireSessionFileRef(fileRef);
    const url = `${this._requireCpApiUrl()}/api/workspace/projects/${encodeURIComponent(String(options.projectId))}`
      + `/files/${encodeURIComponent(canonicalFileRef)}/promote/`;
    const body = await this._requestJson(url, 'POST');
    return parsePublicFileRef(body);
  }

  async stop(): Promise<void> {
    this._requireActiveSessionId();
    await this._session.sendStop();
  }

  private async _connectInternal(): Promise<void> {
    this._disconnectRequested = false;
    this._reconnectAttempt = 0;
    this._stopBackgroundActivity();
    this._resetSessionRuntimeState();
    this._channelState = 'CLOSED';

    const authResponse = await exchangeApiKey(
      this._options.apiKey,
      this._platform.fetchFn,
      this._options.authUrl,
      this._options.workerRef,
      ensureFrontendUuid(),
    );
    this._accessToken = authResponse.access_token;
    this._refreshToken = authResponse.refresh_token;
    this._wsUrl = authResponse.ws_url;
    this._cpApiUrl = normalizeOptionalBaseUrl(authResponse.cp_api_url);

    if (authResponse.auth_required === true) {
      // Auth-required: open WS, do NOT send system::init, resolve connect() immediately.
      // SessionManager sends system::auth via on_open; consumer calls sendLogin();
      // SM sends system::opened after successful login.
      this._authRequired = true;
      await this._openChannel();
      this._session.setTransport(this._transport, this._options.sendTimeout);
      this._startLiveness();
      this._scheduleTokenRefresh();
      return;
    }

    // Public path (unchanged)
    const normalResponse = authResponse as NormalAuthTokenResponse;
    this._bootstrapMeta = asRecord(asRecord(normalResponse.runtime_bootstrap?.trigger_payload)?.meta);
    this._sessionMeta = this._bootstrapMeta;

    await this._openChannel();

    this._session.setTransport(this._transport, this._options.sendTimeout);
    const openWaiter = this._createSessionOpenWaiter();
    await this._session.sendInit(normalResponse.runtime_bootstrap);
    await openWaiter;

    this._startLiveness();
    this._scheduleTokenRefresh();
  }

  private async _openChannel(): Promise<void> {
    if (!this._wsUrl || !this._accessToken) throw new Error('Auth not completed');
    this._suppressNextReconnect = false;
    this._channelState = 'CONNECTING';
    await this._transport.open(this._wsUrl, this._accessToken);
    this._channelState = 'OPEN';
    this._reconnectAttempt = 0;
  }

  private _startLiveness() {
    this._liveness?.stop();
    this._liveness = createLiveness(
      this._transport,
      this._options.pingInterval,
      this._options.pongTimeout,
      this._options.staleThreshold,
      {
        onStale: () => this._handleStale(),
        getSessionId: () => this._session.sessionId,
        getChannelId: () => this._channelId,
      },
    );
    this._liveness.start();
  }

  private _createSessionOpenWaiter(): Promise<void> {
    const waiter = createDeferred<void>();
    this._sessionOpenWaiter = waiter;
    this._clearSessionOpenTimer();
    this._sessionOpenTimer = setTimeout(() => {
      this._rejectSessionOpen(
        makeError('session_open_timeout', 'Session did not open after system::init'),
      );
      this._closeTransportWithoutReconnect(1000, 'session_open_timeout');
    }, this._options.sessionOpenTimeout);
    return waiter.promise;
  }

  private _clearSessionOpenTimer() {
    if (this._sessionOpenTimer !== null) {
      clearTimeout(this._sessionOpenTimer);
      this._sessionOpenTimer = null;
    }
  }

  private _clearSessionOpenWaiter() {
    this._clearSessionOpenTimer();
    this._sessionOpenWaiter = null;
  }

  private _resolveSessionOpen() {
    if (!this._sessionOpenWaiter) {
      return;
    }
    const waiter = this._sessionOpenWaiter;
    this._clearSessionOpenWaiter();
    waiter.resolve();
  }

  private _rejectSessionOpen(error: Error) {
    if (!this._sessionOpenWaiter) {
      return;
    }
    const waiter = this._sessionOpenWaiter;
    this._clearSessionOpenWaiter();
    waiter.reject(error);
  }

  private _handleStale() {
    if (this._channelState === 'STALE' || this._channelState === 'RECONNECTING') return;
    this._channelState = 'STALE';
    this._liveness?.stop();
    this._transport.close(1001, 'stale');
    // onClose will trigger reconnect
  }

  private _handleClose(code: number, reason: string) {
    this._fileTransfers.abortAll();
    if (this._disconnectRequested) return;
    if (this._channelState === 'AUTH_FAILED') return;
    if (this._suppressNextReconnect) {
      this._suppressNextReconnect = false;
      this._channelState = 'CLOSED';
      return;
    }

    // If we're in auth-required state and no session was opened yet, close cleanly.
    // Reconnecting here would send system::resync without a session_id, which is invalid.
    if (this._authRequired && !this._session.sessionId) {
      this._authRequired = false;
      this._channelState = 'CLOSED';
      this._stopBackgroundActivity();
      return;
    }

    if (this._sessionOpenWaiter) {
      this._rejectSessionOpen(
        code === 4001
          ? makeError('auth_invalid', 'Session open failed during authentication')
          : makeError(
            'transport_protocol_violation',
            reason ? `Connection closed before session opened (${reason})` : 'Connection closed before session opened',
          ),
      );
      this._channelState = code === 4001 ? 'AUTH_FAILED' : 'CLOSED';
      this._stopBackgroundActivity();
      return;
    }

    // Auth rejection codes
    if (code === 4001) {
      this._channelState = 'AUTH_FAILED';
      this._stopBackgroundActivity();
      return;
    }

    this._channelState = 'RECONNECTING';
    if (!this._reconnectLoopPromise) {
      this._reconnectLoopPromise = this._reconnectLoop()
        .finally(() => {
          this._reconnectLoopPromise = null;
        });
    }
  }

  private _handleSessionMessage(msg: CortexMessage) {
    if (msg.type === 'system::pong' && typeof msg.payload['heartbeat_id'] === 'string') {
      this._liveness?.handlePong(msg.payload['heartbeat_id'] as string);
      return;
    }

    // After system::login succeeds, SM delivers new post-auth tokens in the accepted payload.
    // Update stored tokens so client.accessToken returns the non-pre-auth token by the
    // time system::opened fires and the widget creates the history client.
    if (msg.type === 'system::auth' && msg.payload['state'] === 'accepted') {
      const p = msg.payload as Record<string, unknown>;
      if (typeof p['access_token'] === 'string' && p['access_token']) {
        this._accessToken = p['access_token'];
      }
      if (typeof p['refresh_token'] === 'string' && p['refresh_token']) {
        this._refreshToken = p['refresh_token'];
      }
    }

    if (msg.type === 'system::opened') {
      const sessionContext = extractSessionContext(msg);
      this._sessionContext = sessionContext;
      this._sessionMeta = mergeLegacySessionMeta(this._bootstrapMeta, sessionContext);
      this._resolveSessionOpen();
    } else if (msg.type === 'system::error' && this._sessionOpenWaiter) {
      const code = typeof msg.payload['code'] === 'string' ? msg.payload['code'] : 'session_not_ready';
      const message = typeof msg.payload['message'] === 'string' ? msg.payload['message'] : 'Session open failed';
      this._rejectSessionOpen(makeError(code, message));
    }

    this._dispatchMessage(msg);
  }

  private _handleSessionFatalError(err: Error) {
    this._fileTransfers.abortAll();
    this._rejectSessionOpen(err);
    this._channelState = 'AUTH_FAILED';
    this._stopBackgroundActivity();
    this._transport.close();
    this._dispatchMessage({
      type: 'system::error',
      schema: '1.0',
      session_id: this._session.sessionId ?? '',
      payload: { code: (err as unknown as { code?: string }).code ?? 'transport_protocol_violation', message: err.message },
      ts: new Date().toISOString(),
    });
  }

  private async _reconnectLoop() {
    while (!this._shouldStopReconnect()) {
      const backoffMs = RECONNECT_BACKOFF_MS[
        Math.min(this._reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)
      ] ?? 30000;
      this._reconnectAttempt++;

      const backoffDelay = this._createCancelableDelay(backoffMs);
      const backoffElapsed = await backoffDelay.promise;
      if (backoffElapsed === CANCELLED || this._shouldStopReconnect()) {
        break;
      }

      // Refresh token if needed
      try {
        await this._maybeRefreshToken();
      } catch {
        this._channelState = 'AUTH_FAILED';
        return;
      }

      try {
        await this._openChannel();
      } catch {
        continue; // retry
      }

      // Re-attach session to transport
      this._session.setTransport(this._transport, this._options.sendTimeout);

      // Resync with timeout
      const resyncTimeout = this._createCancelableDelay(this._options.resyncTimeout);
      try {
        const resyncOutcome = await Promise.race([
          this._session.sendResync().then(() => 'resynced' as const),
          resyncTimeout.promise.then((outcome) => (
            outcome === CANCELLED ? 'cancelled' as const : 'timed_out' as const
          )),
        ]);
        if (resyncOutcome === 'cancelled') {
          return;
        }
        if (resyncOutcome === 'timed_out') {
          throw makeError('resync_timeout', 'Resync timed out');
        }
      } catch {
        this._transport.close();
        continue;
      } finally {
        resyncTimeout.cancel();
      }

      // Restart liveness
      this._startLiveness();
      this._scheduleTokenRefresh();
      return;
    }
  }

  private async _maybeRefreshToken() {
    if (!this._refreshToken) throw makeError('auth_refresh_failed', 'No refresh token');
    if (!this._accessToken || isTokenExpiringSoon(this._accessToken)) {
      this._accessToken = await refreshAccessToken(
        this._refreshToken,
        this._platform.fetchFn,
        this._options.authUrl,
      );
    }
  }

  private _scheduleTokenRefresh() {
    this._stopTokenRefreshTimer();
    if (!this._accessToken) return;

    // Check every 30s — if token is expiring soon, refresh proactively
    this._tokenRefreshTimer = setInterval(async () => {
      if (this._accessToken && isTokenExpiringSoon(this._accessToken) && this._refreshToken) {
        try {
          this._accessToken = await refreshAccessToken(
            this._refreshToken,
            this._platform.fetchFn,
            this._options.authUrl,
          );
        } catch {
          // Will fail at next reconnect and surface there
        }
      }
    }, TOKEN_REFRESH_BUFFER_MS / 2);
  }

  private _stopTokenRefreshTimer() {
    if (this._tokenRefreshTimer !== null) {
      clearInterval(this._tokenRefreshTimer);
      this._tokenRefreshTimer = null;
    }
  }

  private _stopBackgroundActivity() {
    this._liveness?.stop();
    this._stopTokenRefreshTimer();
    this._cancelPendingDelays();
  }

  private _dispatchMessage(message: CortexMessage) {
    try {
      this._options.onMessage(message);
    } catch {
      // Preserve delivery to subscribed handlers even if the constructor callback throws.
    }
    const handlers = Array.from(this._messageHandlers);
    for (const handler of handlers) {
      try {
        handler(message);
      } catch {
        // Isolate subscription errors so other handlers still receive the message.
      }
    }
  }

  private _cleanupFailedConnect() {
    this._stopBackgroundActivity();
    this._resetConnectionRuntimeState();
    this._closeTransportWithoutReconnect();
  }

  private _isSessionReady() {
    return this._channelState === 'OPEN' && this._sessionContext !== null && this._session.sessionId !== null;
  }

  private _shouldStopReconnect() {
    return this._disconnectRequested || this._channelState === 'AUTH_FAILED';
  }

  private _createCancelableDelay(ms: number): { promise: Promise<typeof CANCELLED | true>; cancel: () => void } {
    let settled = false;
    let resolveDelay: (outcome: typeof CANCELLED | true) => void = () => {};

    const promise = new Promise<typeof CANCELLED | true>((resolve) => {
      resolveDelay = resolve;
    });

    const cancel = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this._pendingDelayCancels.delete(cancel);
      resolveDelay(CANCELLED);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      this._pendingDelayCancels.delete(cancel);
      resolveDelay(true);
    }, ms);

    this._pendingDelayCancels.add(cancel);
    return { promise, cancel };
  }

  private _cancelPendingDelays() {
    for (const cancel of Array.from(this._pendingDelayCancels)) {
      cancel();
    }
  }

  private _resetSessionRuntimeState() {
    this._clearSessionOpenWaiter();
    this._session.reset();
    this._sessionContext = null;
    this._sessionMeta = null;
    this._bootstrapMeta = null;
    this._authRequired = false;
  }

  private _resetConnectionRuntimeState() {
    this._resetSessionRuntimeState();
    this._channelState = 'CLOSED';
    this._accessToken = null;
    this._refreshToken = null;
    this._wsUrl = null;
    this._cpApiUrl = null;
  }

  private _closeTransportWithoutReconnect(code?: number, reason?: string) {
    this._suppressNextReconnect = true;
    this._transport.close(code, reason);
  }

  private _requireActiveSessionId(sessionId?: string): string {
    const effectiveSessionId = sessionId ?? this.sessionId;
    if (!effectiveSessionId || !this._isSessionReady()) {
      throw makeError('session_not_ready', 'Session is not ready');
    }
    return effectiveSessionId;
  }

  private _requireSessionId(sessionId?: string): string {
    const effectiveSessionId = sessionId ?? this.sessionId;
    if (!effectiveSessionId) {
      throw makeError('session_not_ready', 'Session is not ready');
    }
    return effectiveSessionId;
  }

  private _requireCpApiUrl(): string {
    if (!this._cpApiUrl) {
      throw makeError('file_api_unavailable', 'Control Plane file API is unavailable');
    }
    return this._cpApiUrl;
  }

  protected async _uploadSessionSource(source: UploadSource, options: UploadFileOptions = {}): Promise<string> {
    let delegated = false;
    try {
      if (!this._accessToken) throw makeError('auth_invalid', 'Not connected');
      const sessionId = this._requireActiveSessionId(options.sessionId);
      delegated = true;
      return await this._fileTransfers.upload(sessionId, source, options.sha256);
    } finally {
      if (!delegated) await source.cleanup();
    }
  }

  private async _requestJson(url: string, method = 'GET'): Promise<Record<string, unknown>> {
    const res = await this._request(url, method);
    const body = await res.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw makeError('file_operation_failed', 'File API returned a non-object response');
    }
    return body as Record<string, unknown>;
  }

  private async _request(url: string, method: string) {
    if (!this._accessToken) throw makeError('auth_invalid', 'Not connected');
    const res = await this._platform.fetchFn(url, {
      method,
      headers: { Authorization: `Bearer ${this._accessToken}` },
    });
    if (!res.ok) {
      throw mapFileResponseError(res.status);
    }
    return res;
  }
}

const CANCELLED = Symbol('cancelled');

function normalizeOptionalBaseUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.trim() === '') return null;
  return url.replace(/\/$/, '');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asNullableString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

function extractSessionContext(message: CortexMessage): SessionContext {
  const payload = asRecord(message.payload) ?? {};
  const identity = asRecord(payload['identity']);
  const correspondent = asRecord(payload['correspondent']);
  const sessionId = message.session_id;
  if (!sessionId) {
    throw makeError('transport_protocol_violation', 'system::opened missing session_id');
  }
  return {
    sessionId,
    status: asNullableString(payload['status']) ?? 'initializing',
    executionMode: asNullableString(payload['execution_mode']) ?? 'production',
    artifactId: asNullableString(payload['artifact_id']),
    artifactKind: asNullableString(payload['artifact_kind']),
    runMode: asNullableString(payload['run_mode']),
    identity: identity
      ? {
        tenantId: asNullableString(identity['tenant_id']),
        projectId: asNullableString(identity['project_id']),
        deploymentId: asNullableString(identity['deployment_id']),
        releaseId: asNullableString(identity['release_id']),
        userId: asNullableString(identity['user_id']),
        userUuid: asNullableString(identity['user_uuid']),
        actorKind: asNullableString(identity['actor_kind']),
        actorRef: asNullableString(identity['actor_ref']),
      }
      : null,
    correspondent: correspondent && asNullableString(correspondent['name'])
      ? {
        kind: asNullableString(correspondent['kind']),
        id: asNullableString(correspondent['id']),
        name: asNullableString(correspondent['name']) as string,
        title: asNullableString(correspondent['title']),
        subtitle: asNullableString(correspondent['subtitle']),
        avatarUrl: asNullableString(correspondent['avatar_url']),
      }
      : null,
  };
}

function mergeLegacySessionMeta(
  bootstrapMeta: Record<string, unknown> | null,
  sessionContext: SessionContext,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(bootstrapMeta ?? {}) };
  if (sessionContext.correspondent) {
    merged['chat_correspondent'] = {
      kind: sessionContext.correspondent.kind ?? undefined,
      id: sessionContext.correspondent.id ?? undefined,
      name: sessionContext.correspondent.name,
      title: sessionContext.correspondent.title ?? undefined,
      subtitle: sessionContext.correspondent.subtitle ?? undefined,
      avatar_url: sessionContext.correspondent.avatarUrl ?? undefined,
    };
  }
  if (sessionContext.identity) {
    merged['identity'] = {
      tenant_id: sessionContext.identity.tenantId,
      project_id: sessionContext.identity.projectId,
      deployment_id: sessionContext.identity.deploymentId,
      release_id: sessionContext.identity.releaseId,
      user_id: sessionContext.identity.userId,
      user_uuid: sessionContext.identity.userUuid,
      actor_kind: sessionContext.identity.actorKind,
      actor_ref: sessionContext.identity.actorRef,
    };
  }
  return merged;
}

function withQueryParams(url: string, params: Record<string, string | number | boolean>): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

function mapFileResponseError(status: number): Error {
  if (status === 401) return makeError('auth_invalid', 'File API authentication failed');
  if (status === 403) return makeError('file_access_denied', 'File access denied');
  if (status === 404) return makeError('file_not_found', 'File not found');
  if (status === 410) return makeError('file_expired', 'File expired');
  return makeError('file_operation_failed', `File operation failed with status ${status}`);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
