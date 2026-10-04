import { SCHEMA_VERSION } from './constants.js';
import { makeError, lookupError } from './errors.js';
import { normalizeSessionFileAttachments } from './files.js';
import type { Transport } from './transport.js';
import type {
  CortexMessage,
  EscalationReplyAction,
  EscalationReplyContent,
  RuntimeBootstrap,
  SessionFileAttachmentInput,
  SessionState,
} from './types.js';

const TERMINAL_STATES = new Set<SessionState>([
  'COMPLETED',
  'FAILED',
  'STOPPED',
  'TIMEOUT',
  'CANCELLED',
]);

const LIFECYCLE_STATE_MAP: Record<string, SessionState> = {
  active: 'ACTIVE',
  waiting: 'WAITING',
  completed: 'COMPLETED',
  failed: 'FAILED',
  stopped: 'STOPPED',
  timeout: 'TIMEOUT',
  cancelled: 'CANCELLED',
};

export interface SessionCallbacks {
  onMessage(msg: CortexMessage): void;
  onFatalError(err: Error): void;
}

export interface SessionController {
  sendInit(bootstrap: RuntimeBootstrap): Promise<void>;
  sendResync(): Promise<void>;
  sendStop(): Promise<void>;
  sendChatMessage(content: unknown, attachments: SessionFileAttachmentInput[] | undefined, meta?: Record<string, unknown>): Promise<void>;
  sendSystemLogin(login: string, password: string): Promise<void>;
  sendEscalationReply(
    escalationId: string,
    waitToken: string,
    action: EscalationReplyAction,
    content: EscalationReplyContent | undefined,
    meta: Record<string, unknown> | undefined,
  ): Promise<void>;
  sendSystemTrigger(content: unknown, attachments: unknown[] | undefined): Promise<void>;
  sendTrigger(payload: Record<string, unknown>): Promise<void>;
  handleIncoming(data: string): void;
  handleMessage(message: CortexMessage): void;
  get sessionId(): string | null;
  get sessionState(): SessionState;
  get lastSeq(): number;
  setTenantId(tenantId: string | null | undefined): void;
  setTransport(transport: Transport, sendTimeoutMs: number): void;
  reset(): void;
}

export function createSession(
  callbacks: SessionCallbacks,
): SessionController {
  let _sessionId: string | null = null;
  let _sessionState: SessionState = 'CREATED';
  let _lastSeq = 0;
  let _transport: Transport | null = null;
  let _sendTimeoutMs = 10000;
  let _tenantId: string | null = null;
  let _opened = false;

  function setSessionState(next: SessionState): void {
    if (TERMINAL_STATES.has(_sessionState) && _sessionState !== next) {
      return;
    }
    _sessionState = next;
  }

  function updateSessionStateFromMessage(msg: CortexMessage): void {
    if (msg.type === 'sandbox::snapshot') {
      const state = typeof msg.payload['state'] === 'string' ? msg.payload['state'].toLowerCase() : null;
      if (state === 'waiting') {
        setSessionState('WAITING');
      }
      return;
    }

    if (msg.type === 'sandbox::lifecycle') {
      const status = typeof msg.payload['status'] === 'string' ? msg.payload['status'].toLowerCase() : null;
      if (status && status in LIFECYCLE_STATE_MAP) {
        setSessionState(LIFECYCLE_STATE_MAP[status]);
      }
      return;
    }

    if (msg.type === 'system::error') {
      const code = typeof msg.payload['code'] === 'string' ? msg.payload['code'] : 'session_terminal';
      if (lookupError(code)?.fatal) {
        setSessionState('FAILED');
      }
    }
  }

  function send(envelope: Record<string, unknown>): Promise<void> {
    if (!_transport) return Promise.reject(new Error('No transport'));
    return _transport.sendJson(envelope, _sendTimeoutMs);
  }

  function reset(): void {
    _sessionId = null;
    _sessionState = 'CREATED';
    _lastSeq = 0;
    _tenantId = null;
    _opened = false;
  }

  function buildEnvelope(type: string, payload: Record<string, unknown>): Record<string, unknown> {
    const env: Record<string, unknown> = {
      type,
      schema: SCHEMA_VERSION,
      payload,
      ts: new Date().toISOString(),
    };
    if (_sessionId) env['session_id'] = _sessionId;
    return env;
  }

  function makeClientMsgId(prefix: string): string {
    const cryptoRef = globalThis.crypto;
    if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
      return `${prefix}_${cryptoRef.randomUUID()}`;
    }
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  }

  function buildMessagePayload(
    content: unknown,
    attachments: SessionFileAttachmentInput[] | undefined,
    meta?: Record<string, unknown>,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = { content, role: 'user' };
    const combinedMeta: Record<string, unknown> = {};
    // meta merged first; official attachments param always wins
    if (meta) Object.assign(combinedMeta, meta);
    if (attachments && attachments.length > 0) {
      combinedMeta['attachments'] = normalizeSessionFileAttachments(attachments);
    }
    if (Object.keys(combinedMeta).length > 0) payload['meta'] = combinedMeta;
    return payload;
  }

  function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function validateEscalationReply(
    escalationId: string,
    waitToken: string,
    action: string,
    content: EscalationReplyContent | undefined,
  ): void {
    if (typeof escalationId !== 'string' || escalationId.trim() === '') {
      throw makeError('transport_protocol_violation', 'escalationId is required');
    }
    if (typeof waitToken !== 'string' || waitToken.trim() === '') {
      throw makeError('transport_protocol_violation', 'waitToken is required');
    }
    if (action !== 'continue' && action !== 'operator_input' && action !== 'reply_user') {
      throw makeError('transport_protocol_violation', `Unsupported escalation reply action: ${action}`);
    }
    if (action === 'continue' && content === undefined) {
      return;
    }
    if (typeof content === 'string') {
      return;
    }
    if (isPlainObject(content)) {
      return;
    }
    throw makeError(
      'transport_protocol_violation',
      `content must be a string or object for escalation action ${action}`,
    );
  }

  function buildEscalationReplyPayload(
    escalationId: string,
    waitToken: string,
    action: EscalationReplyAction,
    content: EscalationReplyContent | undefined,
    meta: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    validateEscalationReply(escalationId, waitToken, action, content);
    const payload: Record<string, unknown> = {
      escalation_id: escalationId.trim(),
      action,
      wait_token: waitToken.trim(),
    };
    if (content !== undefined) {
      payload['content'] = content;
    }
    if (meta !== undefined) {
      payload['meta'] = meta;
    }
    return payload;
  }

  function handleSystemError(payload: Record<string, unknown>) {
    const code = typeof payload['code'] === 'string' ? payload['code'] : 'session_terminal';
    const message = typeof payload['message'] === 'string' ? payload['message'] : 'Runtime error';
    const entry = lookupError(code);
    const fatal = entry?.fatal ?? false;
    const err = makeError(code, message);

    if (fatal) {
      callbacks.onFatalError(err);
    }
    // Pass through to user as a message regardless
    // (the envelope was already dispatched above via onMessage)
  }

  return {
    setTenantId(tenantId: string | null | undefined) {
      const normalized = typeof tenantId === 'string' ? tenantId.trim() : '';
      _tenantId = normalized || null;
    },

    setTransport(transport: Transport, sendTimeoutMs: number) {
      _transport = transport;
      _sendTimeoutMs = sendTimeoutMs;
    },

    reset,

    get sessionId() { return _sessionId; },
    get sessionState() { return _sessionState; },
    get lastSeq() { return _lastSeq; },

    sendInit(bootstrap: RuntimeBootstrap): Promise<void> {
      _sessionId = null;
      _opened = false;
      _sessionState = 'INITIALIZING';
      // system::init has no session_id — intentionally omit it
      const envelope: Record<string, unknown> = {
        type: 'system::init',
        schema: SCHEMA_VERSION,
        payload: bootstrap,
        meta: { client_msg_id: makeClientMsgId('cli_init') },
        ts: new Date().toISOString(),
      };
      if (_tenantId) envelope['tenant_id'] = _tenantId;
      return send(envelope);
    },

    sendResync(): Promise<void> {
      return send(buildEnvelope('system::resync', { last_seq: _lastSeq }));
    },

    sendStop(): Promise<void> {
      return send(buildEnvelope('sandbox::stop', {}));
    },

    sendChatMessage(content: unknown, attachments: SessionFileAttachmentInput[] | undefined, meta?: Record<string, unknown>): Promise<void> {
      return send(buildEnvelope('chat::message', buildMessagePayload(content, attachments, meta)));
    },

    sendSystemLogin(login: string, password: string): Promise<void> {
      const envelope: Record<string, unknown> = {
        type: 'system::login',
        schema: SCHEMA_VERSION,
        payload: { login, password },
        ts: new Date().toISOString(),
      };
      if (_tenantId) envelope['tenant_id'] = _tenantId;
      return send(envelope);
    },

    sendEscalationReply(
      escalationId: string,
      waitToken: string,
      action: EscalationReplyAction,
      content: EscalationReplyContent | undefined,
      meta: Record<string, unknown> | undefined,
    ): Promise<void> {
      return send(buildEnvelope(
        'escalation::reply',
        buildEscalationReplyPayload(escalationId, waitToken, action, content, meta),
      ));
    },

    sendSystemTrigger(content: unknown, attachments: unknown[] | undefined): Promise<void> {
      const payload: Record<string, unknown> = { content };
      if (attachments && attachments.length > 0) {
        payload['meta'] = { attachments };
      }
      return send(buildEnvelope('system::trigger', payload));
    },

    sendTrigger(payload: Record<string, unknown>): Promise<void> {
      return send({
        type: 'system::trigger',
        schema: SCHEMA_VERSION,
        payload: payload || {},
        meta: { client_msg_id: makeClientMsgId('cli_trigger') },
        ts: new Date().toISOString(),
      });
    },

    handleIncoming(data: string) {
      let msg: CortexMessage;
      try { msg = JSON.parse(data) as CortexMessage; } catch { return; }
      this.handleMessage(msg);
    },

    handleMessage(msg: CortexMessage) {

      if (!_opened) {
        if (msg.type === 'system::opened') {
          if (!msg.session_id) {
            callbacks.onFatalError(
              makeError('transport_protocol_violation', 'system::opened requires session_id'),
            );
            return;
          }
          _sessionId = msg.session_id;
          _opened = true;
          if (!TERMINAL_STATES.has(_sessionState)) {
            _sessionState = 'ACTIVE';
          }
        } else if (msg.type !== 'system::error' && msg.type !== 'system::auth') {
          callbacks.onFatalError(
            makeError(
              'transport_protocol_violation',
              `Received ${msg.type} before system::opened`,
            ),
          );
          return;
        }
      }

      // Track sequence
      if (typeof msg.seq === 'number' && msg.seq > _lastSeq) {
        _lastSeq = msg.seq;
      }

      updateSessionStateFromMessage(msg);

      // Handle state-changing message types
      if (msg.type === 'system::error') {
        handleSystemError(msg.payload);
      }

      callbacks.onMessage(msg);
    },
  };
}
