import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';

export interface SchemaViolation {
  message_type: string;
  schema_name: string;
  validation_errors: string[];
  envelope: Record<string, unknown>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCHEMA_DIR = path.resolve(__dirname, '../../shared/schema');

const PAYLOAD_SCHEMA_MAP: Record<string, string> = {
  'system::init': 'system.init.json',
  'system::resync': 'system.resync.json',
  'system::trigger': 'system.trigger.json',
  'system::ping': 'system.ping.json',
  'chat::message': 'chat.message.json',
  'sandbox::continue': 'sandbox.continue.json',
  'sandbox::stop': 'sandbox.stop.json',
  'escalation::reply': 'escalation.reply.json',
};

const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addFormat('date-time', {
  type: 'string',
  validate: (value: string) => typeof value === 'string' && !Number.isNaN(Date.parse(value)),
});

const validatorCache = new Map<string, ValidateFunction>();

function loadValidator(schemaName: string): ValidateFunction {
  const cached = validatorCache.get(schemaName);
  if (cached) {
    return cached;
  }

  const schemaPath = path.join(SCHEMA_DIR, schemaName);
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8')) as object;
  const validator = ajv.compile(schema);
  validatorCache.set(schemaName, validator);
  return validator;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const location = error.instancePath || '/';
    return `${location} ${error.message ?? 'schema validation failed'}`.trim();
  });
}

export function validateOutboundEnvelope(envelope: Record<string, unknown>): SchemaViolation[] {
  const violations: SchemaViolation[] = [];
  const messageType = typeof envelope.type === 'string' ? envelope.type : 'unknown';

  const envelopeValidator = loadValidator('envelope.json');
  if (!envelopeValidator(envelope)) {
    violations.push({
      message_type: messageType,
      schema_name: 'envelope.json',
      validation_errors: formatErrors(envelopeValidator.errors),
      envelope,
    });
  }

  const payloadSchema = PAYLOAD_SCHEMA_MAP[messageType];
  if (!payloadSchema) {
    return violations;
  }

  const payload = envelope.payload;
  const payloadValidator = loadValidator(payloadSchema);
  if (!payloadValidator(payload)) {
    violations.push({
      message_type: messageType,
      schema_name: payloadSchema,
      validation_errors: formatErrors(payloadValidator.errors),
      envelope,
    });
  }

  return violations;
}

const RUNTIME_CHAT_SCHEMA_MAP: Record<string, string> = {
  'chat::answer': 'chat.answer.json',
  'chat::partial': 'chat.partial.json',
  'chat::echo': 'chat.echo.json',
};

/**
 * Server-sent chat::answer/chat::partial/chat::echo payloads must match the
 * Runtime serialization pinned in the shared schemas, so test doubles cannot
 * drift from the real wire shape. meta.attachments is left out: adversarial
 * attachment tests send hostile descriptors on purpose and have their own vectors.
 */
export function validateServerChatPayload(envelope: Record<string, unknown>): string[] {
  const schemaName = typeof envelope.type === 'string' ? RUNTIME_CHAT_SCHEMA_MAP[envelope.type] : undefined;
  if (!schemaName) return [];
  const payload = envelope.payload as Record<string, unknown> | undefined;
  const meta = payload?.['meta'];
  const shape = meta && typeof meta === 'object' && !Array.isArray(meta)
    ? { ...payload, meta: Object.fromEntries(Object.entries(meta).filter(([key]) => key !== 'attachments')) }
    : payload;
  const validator = loadValidator(schemaName);
  return validator(shape) ? [] : formatErrors(validator.errors).map((error) => `${envelope.type} ${error}`);
}
