import { makeError } from './errors.js';
import type { FileListResult, FileRef, SessionFileAttachmentInput } from './types.js';

const FILE_REF_PATTERN = /^sf_[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ATTACHMENT_KEYS = new Set(['file_ref', 'filename', 'content_type', 'size']);
const FILE_DESCRIPTOR_KEYS = [
  'filename', 'content_type', 'size', 'scope_type', 'scope_id', 'status',
  'created_at', 'updated_at', 'expires_at',
] as const;

export function requireSessionFileRef(value: unknown, context = 'file_ref'): string {
  if (typeof value !== 'string' || !FILE_REF_PATTERN.test(value)) {
    throw makeError('file_operation_failed', `${context} must be a canonical sf_ file_ref`);
  }
  return value;
}

export function normalizeSessionFileAttachments(
  attachments: SessionFileAttachmentInput[],
): Array<Record<string, unknown>> {
  return attachments.map((attachment, index) => {
    if (typeof attachment === 'string') {
      return { file_ref: requireSessionFileRef(attachment, `attachments[${index}]`) };
    }
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
      throw makeError('transport_protocol_violation', `attachments[${index}] must be a file_ref or attachment object`);
    }
    const record = attachment as unknown as Record<string, unknown>;
    const unsupported = Object.keys(record).filter((key) => !ATTACHMENT_KEYS.has(key));
    if (unsupported.length > 0) {
      throw makeError('transport_protocol_violation', `attachments[${index}] contains unsupported fields: ${unsupported.join(', ')}`);
    }
    const normalized: Record<string, unknown> = {
      file_ref: requireSessionFileRef(record['file_ref'], `attachments[${index}].file_ref`),
    };
    for (const key of ['filename', 'content_type'] as const) {
      if (record[key] !== undefined) {
        if (typeof record[key] !== 'string') {
          throw makeError('transport_protocol_violation', `attachments[${index}].${key} must be a string`);
        }
        normalized[key] = record[key];
      }
    }
    if (record['size'] !== undefined) {
      if (typeof record['size'] !== 'number' || !Number.isFinite(record['size']) || record['size'] < 0) {
        throw makeError('transport_protocol_violation', `attachments[${index}].size must be a non-negative number`);
      }
      normalized['size'] = record['size'];
    }
    return normalized;
  });
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw makeError('file_operation_failed', 'File list response must be an object');
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record['files']) || typeof record['total'] !== 'number') {
    throw makeError('file_operation_failed', 'File list response is missing files or total');
  }
  return { files: record['files'].map(parsePublicFileRef), total: record['total'] };
}
