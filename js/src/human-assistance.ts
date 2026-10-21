import { makeError } from './errors.js';
import type {
  CortexMessage, HumanAssistanceNotification, HumanAssistanceRequest,
  HumanAssistanceStatus, ReplyHumanAssistanceOptions,
} from './types.js';

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const DEADLINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_REQUESTS = 64;
const TERMINAL = new Set(['resolved', 'expired', 'revoked', 'delivery_failed', 'cancelled']);
const STATUSES = new Set(['reply_accepted', 'reply_rejected', ...TERMINAL]);
const REASONS = new Set(['unauthorized', 'duplicate', 'invalid_answer', 'late', 'not_admitted']);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every((key) => key in value)
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function id(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }

function request(value: unknown): HumanAssistanceRequest | null {
  if (!object(value) || !keys(value, ['version', 'request_id', 'question', 'options', 'allow_text', 'deadline_at', 'status'])
      || value['version'] !== 1 || !id(value['request_id']) || value['status'] !== 'pending'
      || typeof value['question'] !== 'string' || !value['question'].trim() || value['question'].length > 4096
      || typeof value['allow_text'] !== 'boolean' || !Array.isArray(value['options'])
      || value['options'].length > 32 || (!value['options'].length && !value['allow_text'])
      || typeof value['deadline_at'] !== 'string' || !DEADLINE.test(value['deadline_at'])
      || !Number.isFinite(Date.parse(value['deadline_at']))) return null;
  const seen = new Set<string>();
  for (const option of value['options']) {
    if (!object(option) || !keys(option, ['id', 'label']) || !id(option['id'])
        || typeof option['label'] !== 'string' || !option['label'].trim() || option['label'].length > 256
        || seen.has(option['id'])) return null;
    seen.add(option['id']);
  }
  return value as unknown as HumanAssistanceRequest;
}
function status(value: unknown): HumanAssistanceStatus | null {
  if (!object(value) || !keys(value, ['version', 'request_id', 'status'], ['client_reply_id', 'reason'])
      || value['version'] !== 1 || !id(value['request_id'])
      || typeof value['status'] !== 'string' || !STATUSES.has(value['status'])) return null;
  if (value['status'] === 'reply_accepted' || value['status'] === 'reply_rejected') {
    if (!id(value['client_reply_id'])) return null;
  } else if ('client_reply_id' in value) return null;
  if (value['status'] === 'reply_rejected') {
    if (typeof value['reason'] !== 'string' || !REASONS.has(value['reason'])) return null;
  } else if ('reason' in value) return null;
  return value as unknown as HumanAssistanceStatus;
}

export class HumanAssistanceInbox {
  private readonly entries = new Map<string, { request: HumanAssistanceRequest; state: string; seenStatuses: Set<string> }>();
  private readonly terminalBeforeRequest = new Set<string>();
  private terminalOverflow = false;
  private readonly submissions = new Map<string, string>();

  clear(): void {
    this.entries.clear(); this.terminalBeforeRequest.clear(); this.terminalOverflow = false; this.submissions.clear();
  }

  private rememberTerminal(requestId: string): void {
    if (this.terminalBeforeRequest.has(requestId)) return;
    if (this.terminalBeforeRequest.size >= MAX_REQUESTS) {
      this.terminalOverflow = true;
      return;
    }
    this.terminalBeforeRequest.add(requestId);
  }

  requests(): HumanAssistanceRequest[] {
    return [...this.entries.values()].filter((entry) => entry.state === 'pending')
      .map((entry) => structuredClone(entry.request));
  }

  handle(msg: CortexMessage, currentSessionId: string | null): HumanAssistanceNotification | null {
    if (!currentSessionId || msg.schema !== '1.0'
        || (msg.session_id !== undefined && msg.session_id !== currentSessionId)) return null;
    if (msg.type === 'human_assistance::request') {
      const parsed = request(msg.payload);
      if (!parsed) return null;
      if (this.terminalOverflow || this.terminalBeforeRequest.has(parsed.request_id)) return null;
      const old = this.entries.get(parsed.request_id);
      if (old) return null; // Replay is idempotent; a conflicting same-ID request also fails closed.
      if (this.entries.size >= MAX_REQUESTS) {
        const terminal = [...this.entries].find(([, entry]) => TERMINAL.has(entry.state));
        if (terminal) {
          this.rememberTerminal(terminal[0]);
          this.entries.delete(terminal[0]);
        }
      }
      if (this.entries.size >= MAX_REQUESTS) return null;
      this.entries.set(parsed.request_id, { request: structuredClone(parsed), state: 'pending', seenStatuses: new Set() });
      return { type: 'human_assistance::request', payload: structuredClone(parsed) };
    }
    if (msg.type === 'human_assistance::status') {
      const parsed = status(msg.payload);
      if (!parsed) return null;
      const entry = this.entries.get(parsed.request_id);
      if (!entry) {
        if (TERMINAL.has(parsed.status)) this.rememberTerminal(parsed.request_id);
        return null;
      }
      if (TERMINAL.has(entry.state)) return null;
      const signature = `${parsed.status}:${parsed.client_reply_id ?? ''}:${parsed.reason ?? ''}`;
      if (entry.seenStatuses.has(signature)) return null;
      entry.seenStatuses.add(signature);
      if (TERMINAL.has(parsed.status)) entry.state = parsed.status;
      return { type: 'human_assistance::status', payload: { ...parsed } };
    }
    return null;
  }

  reply(options: ReplyHumanAssistanceOptions): Record<string, unknown> {
    if (!object(options) || !keys(options, ['requestId', 'clientReplyId', 'action'], ['optionId', 'text']))
      throw makeError('transport_protocol_violation', 'Invalid HA reply fields');
    const entry = this.entries.get(options.requestId);
    if (!id(options.requestId) || !id(options.clientReplyId) || !entry || entry.state !== 'pending')
      throw makeError('transport_protocol_violation', 'Unknown or inactive HA request');
    if (Date.now() >= Date.parse(entry.request.deadline_at))
      throw makeError('transport_protocol_violation', 'HA request expired');
    const hasOption = options.optionId !== undefined;
    const hasText = options.text !== undefined;
    if ((hasOption && (!id(options.optionId) || !entry.request.options.some((item) => item.id === options.optionId)))
        || (hasText && (typeof options.text !== 'string' || !options.text.trim()
          || options.text.length > 4096 || !entry.request.allow_text))
        || (options.action === 'answer' && !hasOption && !hasText)
        || (options.action === 'refuse' && (hasOption || hasText))
        || (options.action !== 'answer' && options.action !== 'refuse'))
      throw makeError('transport_protocol_violation', 'Invalid HA answer');
    const payload: Record<string, unknown> = {
      version: 1, request_id: options.requestId, client_reply_id: options.clientReplyId,
      action: options.action,
    };
    if (hasOption) payload['option_id'] = options.optionId;
    if (hasText) payload['text'] = options.text;
    const fingerprint = JSON.stringify(payload);
    const old = this.submissions.get(options.clientReplyId);
    if (old && old !== fingerprint) throw makeError('transport_protocol_violation', 'clientReplyId reused with different answer');
    this.submissions.set(options.clientReplyId, fingerprint);
    return payload;
  }
}
