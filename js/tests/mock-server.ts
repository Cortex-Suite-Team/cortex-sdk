/**
 * Mock HTTP + WebSocket server for SDK tests.
 * Simple, not production-grade. Correctness over elegance.
 */
import http from 'node:http';
import net from 'node:net';

import { WebSocketServer, WebSocket } from 'ws';

import {
  validateOutboundEnvelope,
  type SchemaViolation,
} from './schema-validation.js';

export interface ErrorInjectionOptions {
  phase?: 'ws_connect' | 'auth_token' | 'auth_refresh' | 'upload' | 'resync';
  afterMessages?: number;
  onMessageType?: string;
  closeAfterSend?: boolean;
  closeCode?: number;
  closeReason?: string;
  status?: number;
}

interface InjectedError {
  code: string;
  options: ErrorInjectionOptions;
  consumed: boolean;
}

export interface MockServerOptions {
  /** Called when the server receives a WS message from the client. */
  onWsMessage?: (parsed: Record<string, unknown>, ws: WebSocket, server: MockServer) => void;
  autoPong?: boolean;
  autoChatAnswer?: boolean;
  autoInitEcho?: boolean;
  enableSchemaValidation?: boolean;
  initialAccessToken?: string;
  refreshedAccessToken?: string;
  refreshToken?: string;
  /** When true, /auth/token returns auth_required:true (no runtime_bootstrap). */
  authRequired?: boolean;
}

export interface MockServer {
  readonly port: number;
  readonly wsUrl: string;
  readonly httpUrl: string;
  readonly schemaViolations: SchemaViolation[];
  readonly wsConnectionCount: number;
  readonly refreshCallCount: number;
  readonly uploadCallCount: number;
  readonly receivedMessageCount: number;
  received: Array<Record<string, unknown>>;
  receivedFrames: string[];
  clients: Set<WebSocket>;
  dropConnections(): void;
  broadcast(msg: Record<string, unknown>): void;
  sendTo(ws: WebSocket, msg: Record<string, unknown>): void;
  injectError(code: string, options?: ErrorInjectionOptions): void;
  setAuthTokens(tokens: {
    accessToken?: string;
    refreshedAccessToken?: string;
    refreshToken?: string;
  }): void;
  close(): Promise<void>;
}

const FIXED_SESSION_ID = 'sess_abc123';
const FIXED_ACCESS_TOKEN = 'access_token_v1';
const FIXED_REFRESH_TOKEN = 'refresh_token_v1';
const FIXED_ATTACHMENT_ID = 'sf_test123';

let _seq = 0;
function nextSeq(): number { return ++_seq; }
function resetSeq() { _seq = 0; }

function ts(): string { return new Date().toISOString(); }

function makeEnvelope(
  type: string,
  payload: Record<string, unknown>,
  sessionId: string = FIXED_SESSION_ID,
): Record<string, unknown> {
  return {
    type,
    schema: '1.0',
    session_id: sessionId,
    seq: nextSeq(),
    payload,
    ts: ts(),
  };
}

function makeOpenedEnvelope(clientMsgId: string): Record<string, unknown> {
  return makeEnvelope('system::opened', {
    status: 'initializing',
    client_msg_id: clientMsgId,
    execution_mode: 'production',
    artifact_id: 'rel_42',
    artifact_kind: 'graph',
    run_mode: 'normal',
    identity: {
      tenant_id: 'tenant_test',
      project_id: 'project_test',
      deployment_id: 'deploy_test',
      release_id: 'rel_42',
      user_id: null,
      user_uuid: null,
      actor_kind: 'public_widget_user',
      actor_ref: 'public_widget:tenant_test:project_test:live-worker',
    },
    correspondent: {
      kind: 'digital_worker',
      id: 'project_test',
      name: 'Mock Worker',
      title: 'Digital Worker',
      subtitle: null,
      avatar_url: null,
    },
  });
}

function defaultHttpStatus(code: string): number {
  switch (code) {
    case 'auth_invalid':
    case 'auth_refresh_failed':
      return 401;
    default:
      return 400;
  }
}

function makeSystemErrorPayload(code: string): Record<string, unknown> {
  return {
    code,
    message: `Injected ${code}`,
  };
}

export function startMockServer(options: MockServerOptions = {}): Promise<MockServer> {
  const {
    autoPong = true,
    autoChatAnswer = true,
    autoInitEcho = true,
    enableSchemaValidation = false,
    initialAccessToken = FIXED_ACCESS_TOKEN,
    refreshedAccessToken = 'access_token_v2',
    refreshToken = FIXED_REFRESH_TOKEN,
    authRequired = false,
  } = options;

  resetSeq();

  return new Promise((resolve) => {
    const received: Array<Record<string, unknown>> = [];
    const receivedFrames: string[] = [];
    const clients = new Set<WebSocket>();
    const schemaViolations: SchemaViolation[] = [];
    const injections: InjectedError[] = [];
    const hangSockets = new Set<net.Socket>();

    let wsConnectionCount = 0;
    let refreshCallCount = 0;
    let uploadCallCount = 0;
    let currentAccessToken = initialAccessToken;
    let currentRefreshToken = refreshToken;
    let currentRefreshedAccessToken = refreshedAccessToken;
    let httpPort = 0;
    let hangPort = 0;

    function takeInjection(
      predicate: (injection: InjectedError) => boolean,
    ): InjectedError | undefined {
      const match = injections.find((injection) => !injection.consumed && predicate(injection));
      if (match) {
        match.consumed = true;
      }
      return match;
    }

    function maybeSendInjectedError(
      ws: WebSocket,
      code: string,
      injectOptions: ErrorInjectionOptions,
      meta?: Record<string, unknown>,
    ) {
      const envelope = makeEnvelope('system::error', makeSystemErrorPayload(code));
      if (meta) envelope.meta = meta;
      server.sendTo(ws, envelope);
      if (injectOptions.closeAfterSend) {
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(
              injectOptions.closeCode ?? 1011,
              injectOptions.closeReason ?? code,
            );
          }
        }, 0);
      }
    }

    const hangServer = net.createServer((socket) => {
      hangSockets.add(socket);
      socket.on('close', () => hangSockets.delete(socket));
      socket.on('error', () => {});
      socket.on('data', () => {
        // Intentionally do nothing — the WebSocket client hangs until connect timeout.
      });
    });

    const httpServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const requestUrl = new URL(req.url ?? '/', `http://127.0.0.1:${httpPort}`);
        const url = requestUrl.pathname;

        if (req.method === 'POST' && url === '/auth/token') {
          const injection = takeInjection((candidate) => candidate.options.phase === 'auth_token');
          const wsUrl = injection?.code === 'transport_connect_timeout'
            ? `ws://127.0.0.1:${hangPort}/ws`
            : `ws://127.0.0.1:${httpPort}/ws`;

          if (injection && injection.code !== 'transport_connect_timeout') {
            const status = injection.options.status ?? defaultHttpStatus(injection.code);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: injection.code,
              message: `Injected ${injection.code}`,
            }));
            return;
          }

          if (authRequired) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              auth_required: true,
              ws_url: wsUrl,
              cp_api_url: `http://127.0.0.1:${httpPort}`,
              access_token: currentAccessToken,
              refresh_token: currentRefreshToken,
              auth: {
                type: 'system::auth',
                payload: { state: 'required', method: 'login_password', message: 'Sign in required.' },
              },
            }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ws_url: wsUrl,
            cp_api_url: `http://127.0.0.1:${httpPort}`,
            access_token: currentAccessToken,
            refresh_token: currentRefreshToken,
            runtime_bootstrap: {
              execution_mode: 'production',
              bundle_url: '/api/runtime/releases/42/bundle/',
              checksum: 'sha256:release_42',
              session_context: {
                identity: {
                  tenant_id: 'tenant_test',
                  project_id: 'project_test',
                  deployment_id: 'deploy_test',
                  release_id: 'rel_42',
                  user_id: null,
                  user_uuid: null,
                  actor_kind: 'public_widget_user',
                  actor_ref: 'public_widget:tenant_test:project_test:live-worker',
                },
                correspondent: {
                  kind: 'digital_worker',
                  id: 'project_test',
                  name: 'Mock Worker',
                  title: 'Digital Worker',
                  subtitle: null,
                  avatar_url: null,
                },
              },
            },
          }));
          return;
        }

        if (req.method === 'POST' && url === '/auth/refresh') {
          refreshCallCount++;
          const injection = takeInjection((candidate) => candidate.options.phase === 'auth_refresh');
          if (injection) {
            const status = injection.options.status ?? defaultHttpStatus(injection.code);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: injection.code,
              message: `Injected ${injection.code}`,
            }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ access_token: currentRefreshedAccessToken }));
          return;
        }

        if (req.method === 'GET' && url.startsWith('/api/workspace/projects/') && url.endsWith('/files/')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            files: [{
              file_ref: FIXED_ATTACHMENT_ID,
              filename: 'upload',
              scope_type: 'persistent',
              scope_id: '42',
              status: 'ready',
            }],
            total: 1,
          }));
          return;
        }

        if (req.method === 'POST' && url.startsWith('/api/workspace/projects/') && url.endsWith('/promote/')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            file_ref: FIXED_ATTACHMENT_ID,
            filename: 'upload',
            scope_type: 'persistent',
            scope_id: '42',
            status: 'ready',
          }));
          return;
        }

        if (req.method === 'GET' && url.startsWith('/api/workspace/projects/') && url.endsWith('/download/')) {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(Buffer.from('project file bytes'));
          return;
        }

        res.writeHead(404);
        res.end();
      });
    });

    const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    wss.on('connection', (ws, req) => {
      wsConnectionCount++;
      const protocols = req.headers['sec-websocket-protocol'] ?? '';
      const hasJwtProtocol = protocols.split(',').some((protocol) => protocol.trim().startsWith('cortex-sdk.jwt.'));
      if (!hasJwtProtocol) {
        ws.close(4001, 'auth_invalid');
        return;
      }

      const connectInjection = takeInjection((candidate) => candidate.options.phase === 'ws_connect');
      if (connectInjection?.code === 'auth_invalid') {
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(4001, 'auth_invalid');
          }
        }, 25);
        clients.add(ws);
        ws.on('close', () => clients.delete(ws));
        return;
      }

      clients.add(ws);
      ws.on('close', () => clients.delete(ws));

      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          receivedFrames.push(data.toString('hex'));
          return;
        }
        receivedFrames.push(data.toString());
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data.toString()) as Record<string, unknown>;
        } catch {
          return;
        }

        received.push(parsed);

        if (enableSchemaValidation) {
          const violations = validateOutboundEnvelope(parsed);
          if (violations.length > 0) {
            schemaViolations.push(...violations);
            for (const violation of violations) {
              console.error('[mock-server] schema violation', JSON.stringify(violation, null, 2));
            }
            server.sendTo(ws, makeEnvelope(
              'system::error',
              makeSystemErrorPayload('transport_protocol_violation'),
            ));
            return;
          }
        }

        const messageType = parsed.type;
        const matchedInjection = takeInjection((candidate) => {
          const phase = candidate.options.phase;
          if (phase && phase !== 'resync') {
            return false;
          }
          const expectedType = phase === 'resync'
            ? 'system::resync'
            : candidate.options.onMessageType;
          const seenBefore = received.length - 1;
          const afterMatches = candidate.options.afterMessages === undefined
            || seenBefore >= candidate.options.afterMessages;
          const typeMatches = expectedType === undefined || expectedType === messageType;
          return afterMatches && typeMatches;
        });

        if (matchedInjection) {
          maybeSendInjectedError(
            ws,
            matchedInjection.code,
            matchedInjection.options,
            typeof messageType === 'string' && messageType.startsWith('file::')
              ? parsed.meta as Record<string, unknown>
              : undefined,
          );
          if (matchedInjection.options.closeAfterSend) {
            return;
          }
        }

        if (messageType === 'system::init' && autoInitEcho) {
          const meta = parsed.meta as Record<string, unknown> | undefined;
          const clientMsgId = typeof meta?.['client_msg_id'] === 'string' ? meta['client_msg_id'] : 'cli_init_test';
          server.sendTo(ws, makeOpenedEnvelope(clientMsgId));
        }

        if (messageType === 'system::ping' && autoPong) {
          const payload = parsed.payload as Record<string, unknown>;
          server.sendTo(ws, {
            type: 'system::pong',
            schema: '1.0',
            session_id: FIXED_SESSION_ID,
            payload: {
              heartbeat_id: payload.heartbeat_id,
              channel_id: payload.channel_id,
              server_ts: ts(),
            },
            ts: ts(),
          });
        }

        const meta = parsed.meta as Record<string, unknown> | undefined;
        const correlation = { client_msg_id: meta?.['client_msg_id'] };
        if (messageType === 'file::upload.prepare') {
          server.sendTo(ws, {
            type: 'file::upload.ready', schema: '1.0', session_id: FIXED_SESSION_ID,
            payload: { transfer_id: 'ft_01010101010101010101010101010101', chunk_bytes: 2, max_bytes: 52428800 },
            meta: correlation, ts: ts(),
          });
        }
        if (messageType === 'file::upload.commit') {
          server.sendTo(ws, {
            type: 'file::upload.complete', schema: '1.0', session_id: FIXED_SESSION_ID,
            payload: { transfer_id: 'ft_01010101010101010101010101010101', file_ref: FIXED_ATTACHMENT_ID },
            meta: correlation, ts: ts(),
          });
        }
        if (messageType === 'file::download.prepare') {
          const transferId = 'ft_02020202020202020202020202020202';
          const bytes = Buffer.from('mock file bytes');
          server.sendTo(ws, {
            type: 'file::download.ready', schema: '1.0', session_id: FIXED_SESSION_ID,
            payload: { transfer_id: transferId, filename: 'upload', content_type: 'application/octet-stream', size: bytes.length, chunk_bytes: 262144 },
            meta: correlation, ts: ts(),
          });
          setTimeout(() => {
            if (ws.readyState !== WebSocket.OPEN) return;
            const header = Buffer.alloc(24);
            header.write('CFT1', 0, 'ascii');
            Buffer.from(transferId.slice(3), 'hex').copy(header, 4);
            header.writeUInt32BE(0, 20);
            ws.send(Buffer.concat([header, bytes]), { binary: true });
            server.sendTo(ws, { type: 'file::download.complete', schema: '1.0', session_id: FIXED_SESSION_ID, payload: { transfer_id: transferId }, ts: ts() });
          }, 0);
        }
        if (messageType === 'file::list') {
          server.sendTo(ws, {
            type: 'file::list.result', schema: '1.0', session_id: FIXED_SESSION_ID,
            payload: { files: [{ file_ref: FIXED_ATTACHMENT_ID, filename: 'upload', scope_type: 'session', scope_id: FIXED_SESSION_ID, status: 'ready' }], total: 1 },
            meta: correlation, ts: ts(),
          });
        }

        if (messageType === 'chat::message' && autoChatAnswer && !matchedInjection) {
          server.sendTo(ws, makeEnvelope('chat::answer', {
            content: 'Mock answer',
            role: 'assistant',
            answer_kind: 'final',
            turn_id: `turn_${nextSeq()}`,
          }));
        }

        options.onWsMessage?.(parsed, ws, server);
      });
    });

    const server: MockServer = {
      get port() {
        return (httpServer.address() as { port: number }).port;
      },
      get wsUrl() {
        return `ws://127.0.0.1:${server.port}/ws`;
      },
      get httpUrl() {
        return `http://127.0.0.1:${server.port}`;
      },
      get schemaViolations() {
        return schemaViolations;
      },
      get wsConnectionCount() {
        return wsConnectionCount;
      },
      get refreshCallCount() {
        return refreshCallCount;
      },
      get uploadCallCount() {
        return uploadCallCount;
      },
      get receivedMessageCount() {
        return received.length;
      },
      received,
      receivedFrames,
      clients,

      dropConnections() {
        for (const client of clients) {
          client.terminate();
        }
      },

      broadcast(msg) {
        const encoded = JSON.stringify(msg);
        for (const client of clients) {
          client.send(encoded);
        }
      },

      sendTo(ws, msg) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      },

      injectError(code, injectionOptions = {}) {
        injections.push({
          code,
          options: injectionOptions,
          consumed: false,
        });
      },

      setAuthTokens(tokens) {
        if (tokens.accessToken !== undefined) {
          currentAccessToken = tokens.accessToken;
        }
        if (tokens.refreshedAccessToken !== undefined) {
          currentRefreshedAccessToken = tokens.refreshedAccessToken;
        }
        if (tokens.refreshToken !== undefined) {
          currentRefreshToken = tokens.refreshToken;
        }
      },

      close(): Promise<void> {
        return new Promise((resolveClose, rejectClose) => {
          for (const client of clients) {
            client.terminate();
          }
          for (const socket of hangSockets) {
            socket.destroy();
          }
          hangServer.close(() => {
            httpServer.close((error) => {
              if (error) {
                rejectClose(error);
              } else {
                resolveClose();
              }
            });
          });
        });
      },
    };

    hangServer.listen(0, '127.0.0.1', () => {
      hangPort = (hangServer.address() as net.AddressInfo).port;
      httpServer.listen(0, '127.0.0.1', () => {
        httpPort = (httpServer.address() as net.AddressInfo).port;
        resolve(server);
      });
    });
  });
}

export { FIXED_SESSION_ID, FIXED_ATTACHMENT_ID };
