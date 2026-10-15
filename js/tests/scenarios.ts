import { WebSocket } from 'ws';

import { startMockServer, FIXED_ATTACHMENT_ID, FIXED_SESSION_ID, type MockServer } from './mock-server.js';
import { makeClient } from './test-client-factory.js';
import { waitFor } from './helpers.js';
import type { CortexMessage } from '../src/types.js';
import type { SchemaViolation } from './schema-validation.js';

export type ScenarioName =
  | 'normal_chat'
  | 'streaming_chat'
  | 'reconnect_resync'
  | 'auth_refresh'
  | 'file_upload'
  | 'liveness';

export interface ScenarioResult {
  scenario: string;
  messages_received: Array<{ type: string; seq?: number }>;
  session_state_final: string;
  channel_state_final: string;
  errors_received: string[];
  callback_call_count: number;
}

export interface ScenarioExecution {
  result: ScenarioResult;
  schema_violations: SchemaViolation[];
  diagnostics: {
    ws_connection_count: number;
    refresh_call_count: number;
    upload_call_count: number;
    received_message_count: number;
  };
}

export interface ScenarioOptions {
  schemaValidation?: boolean;
}

function snapshotResult(
  scenario: ScenarioName,
  client: ReturnType<typeof makeClient>,
  received: CortexMessage[],
): ScenarioResult {
  return {
    scenario,
    messages_received: received.map((message) => ({
      type: message.type,
      seq: typeof message.seq === 'number' ? message.seq : undefined,
    })),
    session_state_final: client.sessionState,
    channel_state_final: client.channelState,
    errors_received: received
      .filter((message) => message.type === 'system::error')
      .map((message) => String(message.payload['code'])),
    callback_call_count: received.length,
  };
}

function finalizeExecution(
  scenario: ScenarioName,
  client: ReturnType<typeof makeClient>,
  server: MockServer,
  received: CortexMessage[],
): ScenarioExecution {
  return {
    result: snapshotResult(scenario, client, received),
    schema_violations: [...server.schemaViolations],
    diagnostics: {
      ws_connection_count: server.wsConnectionCount,
      refresh_call_count: server.refreshCallCount,
      upload_call_count: server.uploadCallCount,
      received_message_count: server.receivedMessageCount,
    },
  };
}

function makeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.fakesig`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runNormalChatScenario(options: ScenarioOptions = {}): Promise<ScenarioExecution> {
  const server = await startMockServer({
    autoChatAnswer: true,
    autoInitEcho: true,
    enableSchemaValidation: options.schemaValidation,
  });
  const received: CortexMessage[] = [];
  const client = makeClient(server, (message) => received.push(message));

  try {
    await client.connect();
    await waitFor(() => client.sessionId !== null);
    await client.sendMessage({ content: 'Hello runtime' });
    await waitFor(() => received.some((message) => message.type === 'chat::answer' && message.payload['answer_kind'] === 'final'));
    return finalizeExecution('normal_chat', client, server, received);
  } finally {
    await client.disconnect();
    await server.close();
  }
}

export async function runStreamingChatScenario(options: ScenarioOptions = {}): Promise<ScenarioExecution> {
  let streamSent = false;
  const server = await startMockServer({
    autoChatAnswer: false,
    autoInitEcho: true,
    enableSchemaValidation: options.schemaValidation,
    onWsMessage: (parsed, ws, srv) => {
      if (parsed['type'] === 'chat::message' && !streamSent) {
        streamSent = true;
        let seq = 1;
        const makeEnv = (type: string, payload: Record<string, unknown>) => ({
          type,
          schema: '1.0',
          session_id: FIXED_SESSION_ID,
          seq: seq++,
          payload,
          ts: new Date().toISOString(),
        });
        srv.sendTo(ws, makeEnv('chat::partial', {
          content: 'Quantum entanglement is ',
          role: 'assistant',
          turn_id: 'turn_002',
        }));
        srv.sendTo(ws, makeEnv('chat::partial', {
          content: 'a phenomenon where two particles ',
          role: 'assistant',
          turn_id: 'turn_002',
        }));
        srv.sendTo(ws, makeEnv('chat::answer', {
          content: ['Quantum entanglement is a phenomenon where two particles remain correlated regardless of distance.'],
          role: 'assistant',
          answer_kind: 'final',
          turn: 2,
        }));
      }
    },
  });
  const received: CortexMessage[] = [];
  const client = makeClient(server, (message) => received.push(message));

  try {
    await client.connect();
    await waitFor(() => client.sessionId !== null);
    await client.sendMessage({ content: 'Explain quantum entanglement briefly.' });
    await waitFor(() => received.some((message) => message.type === 'chat::answer' && message.payload['answer_kind'] === 'final'), 3000);
    return finalizeExecution('streaming_chat', client, server, received);
  } finally {
    await client.disconnect();
    await server.close();
  }
}

export async function runReconnectResyncScenario(options: ScenarioOptions = {}): Promise<ScenarioExecution> {
  let resynced = false;
  const server = await startMockServer({
    autoInitEcho: true,
    autoChatAnswer: false,
    enableSchemaValidation: options.schemaValidation,
    onWsMessage: (parsed, ws, srv) => {
      if (parsed['type'] === 'system::resync') {
        resynced = true;
        srv.sendTo(ws, {
          type: 'chat::answer',
          schema: '1.0',
          session_id: FIXED_SESSION_ID,
          seq: 1,
          payload: {
            content: ['Long task completed'],
            role: 'assistant',
            answer_kind: 'final',
            turn: 3,
          },
          ts: new Date().toISOString(),
        });
      }
    },
  });
  const received: CortexMessage[] = [];
  const client = makeClient(server, (message) => received.push(message), {
    pingInterval: 60000,
    staleThreshold: 60000,
  });

  try {
    await client.connect();
    await waitFor(() => client.sessionId !== null);
    await client.sendMessage({ content: 'Start a long task' });
    server.dropConnections();
    await waitFor(() => resynced, 5000);
    await waitFor(() => received.some((message) => message.type === 'chat::answer' && message.payload['answer_kind'] === 'final'), 5000);
    return finalizeExecution('reconnect_resync', client, server, received);
  } finally {
    await client.disconnect();
    await server.close();
  }
}

export async function runAuthRefreshScenario(options: ScenarioOptions = {}): Promise<ScenarioExecution> {
  let firstAnswerSent = false;
  let secondAnswerSent = false;
  const expiringToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 30 });
  const refreshedToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });

  const server = await startMockServer({
    autoInitEcho: true,
    autoChatAnswer: false,
    enableSchemaValidation: options.schemaValidation,
    initialAccessToken: expiringToken,
    refreshedAccessToken: refreshedToken,
    onWsMessage: (parsed, ws, srv) => {
      if (parsed['type'] === 'chat::message' && !firstAnswerSent) {
        firstAnswerSent = true;
        srv.sendTo(ws, {
          type: 'chat::answer',
          schema: '1.0',
          session_id: FIXED_SESSION_ID,
          seq: 1,
          payload: {
            content: ['Response to first message'],
            role: 'assistant',
            answer_kind: 'final',
            turn: 4,
          },
          ts: new Date().toISOString(),
        });
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(1011, 'refresh');
          }
        }, 25);
        return;
      }

      if (parsed['type'] === 'chat::message' && firstAnswerSent && !secondAnswerSent) {
        secondAnswerSent = true;
        srv.sendTo(ws, {
          type: 'chat::answer',
          schema: '1.0',
          session_id: FIXED_SESSION_ID,
          seq: 2,
          payload: {
            content: ['Response to second message'],
            role: 'assistant',
            answer_kind: 'final',
            turn: 5,
          },
          ts: new Date().toISOString(),
        });
      }
    },
  });
  const received: CortexMessage[] = [];
  const client = makeClient(server, (message) => received.push(message), {
    pingInterval: 60000,
    staleThreshold: 60000,
    resyncTimeout: 2000,
  });

  try {
    await client.connect();
    await waitFor(() => client.sessionId !== null);
    await client.sendMessage({ content: 'First message before refresh' });
    await waitFor(() => received.some((message) => message.type === 'chat::answer' && message.payload['turn'] === 4), 3000);
    await waitFor(() => server.refreshCallCount >= 1, 5000);
    await waitFor(() => server.wsConnectionCount >= 2, 5000);
    await client.sendMessage({ content: 'Second message after refresh' });
    await waitFor(() => received.some((message) => message.type === 'chat::answer' && message.payload['turn'] === 5), 3000);
    return finalizeExecution('auth_refresh', client, server, received);
  } finally {
    await client.disconnect();
    await server.close();
  }
}

export async function runFileUploadScenario(options: ScenarioOptions = {}): Promise<ScenarioExecution> {
  const server = await startMockServer({
    autoInitEcho: true,
    autoChatAnswer: false,
    enableSchemaValidation: options.schemaValidation,
    onWsMessage: (parsed, ws, srv) => {
      if (parsed['type'] === 'chat::message') {
        srv.sendTo(ws, {
          type: 'chat::answer',
          schema: '1.0',
          session_id: FIXED_SESSION_ID,
          seq: 1,
          payload: {
            content: ['The document covers three main topics.'],
            role: 'assistant',
            answer_kind: 'final',
            turn: 6,
          },
          ts: new Date().toISOString(),
        });
      }
    },
  });
  const received: CortexMessage[] = [];
  const client = makeClient(server, (message) => received.push(message));

  try {
    await client.connect();
    await waitFor(() => client.sessionId !== null);
    const attachmentId = await client.uploadAttachment(new Uint8Array([1, 2, 3, 4]));
    if (attachmentId !== FIXED_ATTACHMENT_ID) {
      throw new Error(`unexpected attachment id ${attachmentId}`);
    }
    await client.sendMessage({
      content: 'Please summarize this document.',
      attachments: [attachmentId],
    });
    await waitFor(() => received.some((message) => message.type === 'chat::answer' && message.payload['answer_kind'] === 'final'), 3000);
    return finalizeExecution('file_upload', client, server, received);
  } finally {
    await client.disconnect();
    await server.close();
  }
}

export async function runLivenessScenario(options: ScenarioOptions = {}): Promise<ScenarioExecution> {
  let pingSentCount = 0;
  const server = await startMockServer({
    autoInitEcho: true,
    autoPong: true,
    autoChatAnswer: false,
    enableSchemaValidation: options.schemaValidation,
    onWsMessage: (parsed) => {
      if (parsed['type'] === 'system::ping') {
        pingSentCount++;
      }
    },
  });
  const received: CortexMessage[] = [];
  const client = makeClient(server, (message) => received.push(message), {
    pingInterval: 100,
    pongTimeout: 500,
    staleThreshold: 5000,
  });

  try {
    await client.connect();
    await waitFor(() => client.sessionId !== null);
    await waitFor(() => pingSentCount >= 2, 3000);
    await delay(50);
    return finalizeExecution('liveness', client, server, received);
  } finally {
    await client.disconnect();
    await server.close();
  }
}

export async function runScenarioByName(
  scenario: ScenarioName,
  options: ScenarioOptions = {},
): Promise<ScenarioExecution> {
  switch (scenario) {
    case 'normal_chat':
      return runNormalChatScenario(options);
    case 'streaming_chat':
      return runStreamingChatScenario(options);
    case 'reconnect_resync':
      return runReconnectResyncScenario(options);
    case 'auth_refresh':
      return runAuthRefreshScenario(options);
    case 'file_upload':
      return runFileUploadScenario(options);
    case 'liveness':
      return runLivenessScenario(options);
    default:
      throw new Error(`Unknown scenario ${(scenario as never)}`);
  }
}

export const SCENARIO_NAMES: ScenarioName[] = [
  'normal_chat',
  'streaming_chat',
  'reconnect_resync',
  'auth_refresh',
  'file_upload',
  'liveness',
];
