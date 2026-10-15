import { MAX_ATTACHMENTS_PER_MESSAGE } from './constants.js';
import { makeError } from './errors.js';
import type {
  CortexMessage,
  FileListResult,
  FileRef,
  SessionFileAttachmentInput,
  SessionFileDescriptor,
} from './types.js';

const FILE_REF_PATTERN = /^sf_[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ATTACHMENT_KEYS = new Set(['file_ref', 'filename', 'content_type', 'size']);
const FILE_DESCRIPTOR_KEYS = [
  'filename', 'content_type', 'size', 'scope_type', 'scope_id', 'status',
  'created_at', 'updated_at', 'expires_at',
] as const;
const OWNER_ROLES = new Set(['user', 'assistant', 'operator', 'system']);
const DIRECTIONS = new Set(['inbound', 'outbound', 'internal']);
const STATES = new Set(['available', 'expired', 'deleted', 'quarantined']);
const MESSAGE_REF_KINDS = new Set(['client_msg_id', 'turn']);
// An identity field must never carry an internal File Layer identity.
const INTERNAL_VALUE_PREFIXES = ['fi_', 'sn_'];

export function requireSessionFileRef(value: unknown, context = 'file_ref'): string {
  if (typeof value !== 'string' || !FILE_REF_PATTERN.test(value)) {
    throw makeError('file_operation_failed', `${context} must be a canonical sf_ file_ref`);
  }
  return value;
}

export function normalizeSessionFileAttachments(
  attachments: SessionFileAttachmentInput[],
): Array<Record<string, unknown>> {
  if (!Array.isArray(attachments)) {
    throw makeError('invalid_attachment', 'attachments must be an array');
  }
  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw makeError(
      'too_many_attachments',
      `At most ${MAX_ATTACHMENTS_PER_MESSAGE} file(s) may be attached per message.`,
    );
  }
  const seen = new Set<string>();
  return attachments.map((attachment, index) => {
    const normalized = normalizeAttachment(attachment, index);
    const fileRef = normalized['file_ref'] as string;
    if (seen.has(fileRef)) {
      throw makeError('invalid_attachment', `attachments[${index}] duplicates ${fileRef}`);
    }
    seen.add(fileRef);
    return normalized;
  });
}

function normalizeAttachment(attachment: SessionFileAttachmentInput, index: number): Record<string, unknown> {
  if (typeof attachment === 'string') {
    return { file_ref: requireAttachmentRef(attachment, `attachments[${index}]`) };
  }
  if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
    throw makeError('invalid_attachment', `attachments[${index}] must be a file_ref or attachment object`);
  }
  const record = attachment as unknown as Record<string, unknown>;
  const unsupported = Object.keys(record).filter((key) => !ATTACHMENT_KEYS.has(key));
  if (unsupported.length > 0) {
    throw makeError('invalid_attachment', `attachments[${index}] contains unsupported fields: ${unsupported.join(', ')}`);
  }
  const normalized: Record<string, unknown> = {
    file_ref: requireAttachmentRef(record['file_ref'], `attachments[${index}].file_ref`),
  };
  for (const key of ['filename', 'content_type'] as const) {
    if (record[key] !== undefined) {
      if (typeof record[key] !== 'string') {
        throw makeError('invalid_attachment', `attachments[${index}].${key} must be a string`);
      }
      normalized[key] = record[key];
    }
  }
  if (record['size'] !== undefined) {
    if (typeof record['size'] !== 'number' || !Number.isFinite(record['size']) || record['size'] < 0) {
      throw makeError('invalid_attachment', `attachments[${index}].size must be a non-negative number`);
    }
    normalized['size'] = record['size'];
  }
  return normalized;
}

function requireAttachmentRef(value: unknown, context: string): string {
  if (typeof value !== 'string' || !FILE_REF_PATTERN.test(value)) {
    throw makeError('invalid_attachment', `${context} must be a canonical sf_ file_ref`);
  }
  return value;
}

/**
 * Explicit public projection of one session-file descriptor.
 *
 * Only the nine public fields survive; anything else (internal identity,
 * scope, storage keys, tickets, URLs) is dropped. A descriptor whose public
 * fields are missing or invalid is not a public file and yields null.
 */
export function parsePublicAttachment(value: unknown): SessionFileDescriptor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const fileRef = record['file_ref'];
  const filename = record['filename'];
  const contentType = record['content_type'];
  const size = record['size'];
  const ownerRole = record['owner_role'];
  const direction = record['direction'];
  const state = record['state'];
  if (typeof fileRef !== 'string' || !FILE_REF_PATTERN.test(fileRef)) return null;
  if (!isNonEmptyString(filename) || !isNonEmptyString(contentType)) return null;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null;
  if (typeof ownerRole !== 'string' || !OWNER_ROLES.has(ownerRole)) return null;
  if (typeof direction !== 'string' || !DIRECTIONS.has(direction)) return null;
  if (typeof state !== 'string' || !STATES.has(state)) return null;
  const descriptor: SessionFileDescriptor = {
    file_ref: fileRef,
    filename: filename as string,
    content_type: contentType as string,
    size,
    owner_role: ownerRole as SessionFileDescriptor['owner_role'],
    direction: direction as SessionFileDescriptor['direction'],
    state: state as SessionFileDescriptor['state'],
  };
  const messageRef = record['message_ref'];
  const messageRefKind = record['message_ref_kind'];
  if (messageRef !== undefined && messageRef !== null) {
    if (!isPublicIdentity(messageRef)) return null;
    descriptor.message_ref = messageRef as string;
  }
  if (messageRefKind !== undefined && messageRefKind !== null) {
    if (typeof messageRefKind !== 'string' || !MESSAGE_REF_KINDS.has(messageRefKind)) return null;
    descriptor.message_ref_kind = messageRefKind as SessionFileDescriptor['message_ref_kind'];
  }
  return descriptor;
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

function isPublicIdentity(value: unknown): boolean {
  return isNonEmptyString(value) && !INTERNAL_VALUE_PREFIXES.some((prefix) => (value as string).startsWith(prefix));
}

interface MessageFileBinding {
  ownerRole: SessionFileDescriptor['owner_role'];
  direction: SessionFileDescriptor['direction'];
  messageRefKind: NonNullable<SessionFileDescriptor['message_ref_kind']>;
  messageRef: string | null;
}

function messageFileBinding(message: CortexMessage): MessageFileBinding | null {
  const payload = message.payload ?? {};
  if (message.type === 'chat::answer') {
    return {
      ownerRole: 'assistant',
      direction: 'outbound',
      messageRefKind: 'turn',
      messageRef: turnIdentity(payload),
    };
  }
  // Runtime also echoes operator escalation replies; only a user echo owns user files.
  if (message.type === 'chat::echo' && payload['role'] !== 'user') return null;
  if (message.type === 'chat::echo' || message.type === 'chat::message') {
    const meta = asRecord(payload['meta']);
    const clientMsgId = meta?.['client_msg_id'];
    return {
      ownerRole: 'user',
      direction: 'inbound',
      messageRefKind: 'client_msg_id',
      messageRef: typeof clientMsgId === 'string' && clientMsgId ? clientMsgId : null,
    };
  }
  return null;
}

// Runtime serializes the turn as an integer; files bind to String(turn).
function turnIdentity(payload: Record<string, unknown>): string | null {
  const turn = payload['turn'];
  if (typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0) return String(turn);
  return null;
}

/**
 * Public files that belong to this message, in the order the server sent them,
 * at most MAX_ATTACHMENTS_PER_MESSAGE.
 *
 * An assistant answer only owns assistant/outbound files bound to String(turn);
 * a user message only owns user/inbound files bound to its client_msg_id. The
 * binding must be explicit and exact on both sides: a descriptor without
 * message_ref/message_ref_kind, or a message without a trusted identity (an
 * answer without turn, an echo without client_msg_id), owns nothing. Other
 * message types own no files. Invalid and repeated descriptors are excluded.
 */
export function parseMessageAttachments(message: CortexMessage): SessionFileDescriptor[] {
  const meta = asRecord(message.payload?.['meta']);
  const raw = meta?.['attachments'];
  const binding = messageFileBinding(message);
  if (!Array.isArray(raw) || !binding || binding.messageRef === null) return [];
  const seen = new Set<string>();
  const result: SessionFileDescriptor[] = [];
  for (const item of raw) {
    if (result.length >= MAX_ATTACHMENTS_PER_MESSAGE) break;
    const descriptor = parsePublicAttachment(item);
    if (!descriptor || seen.has(descriptor.file_ref) || !belongsToMessage(descriptor, binding)) continue;
    seen.add(descriptor.file_ref);
    result.push(descriptor);
  }
  return result;
}

function belongsToMessage(descriptor: SessionFileDescriptor, binding: MessageFileBinding): boolean {
  return descriptor.owner_role === binding.ownerRole
    && descriptor.direction === binding.direction
    && descriptor.message_ref_kind === binding.messageRefKind
    && descriptor.message_ref === binding.messageRef;
}

/** Replace payload.meta.attachments of an inbound message with its public projection. */
export function sanitizeMessageAttachments(message: CortexMessage): CortexMessage {
  const meta = asRecord(message.payload?.['meta']);
  if (meta && 'attachments' in meta) {
    meta['attachments'] = parseMessageAttachments(message);
  }
  return message;
}

export function parsePublicFileRef(value: unknown): FileRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw makeError('file_operation_failed', 'File API response contained an invalid descriptor');
  }
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {
    file_ref: requireSessionFileRef(record['file_ref'], 'File API response file_ref'),
  };
  for (const key of FILE_DESCRIPTOR_KEYS) {
    if (record[key] !== undefined) result[key] = record[key];
  }
  return result as unknown as FileRef;
}

export function parsePublicFileList(value: unknown): FileListResult {
  const record = requireFileListRecord(value);
  return { files: (record['files'] as unknown[]).map(parsePublicFileRef), total: record['total'] as number };
}

/** Session file::list.result: every entry must be a valid public descriptor. */
export function parseSessionFileList(value: unknown): FileListResult {
  const record = requireFileListRecord(value);
  const files = (record['files'] as unknown[]).map((item) => {
    const descriptor = parsePublicAttachment(item);
    if (!descriptor) throw makeError('file_operation_failed', 'File list response contained an invalid descriptor');
    return descriptor;
  });
  return { files, total: record['total'] as number };
}

function requireFileListRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw makeError('file_operation_failed', 'File list response must be an object');
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record['files']) || typeof record['total'] !== 'number') {
    throw makeError('file_operation_failed', 'File list response is missing files or total');
  }
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
