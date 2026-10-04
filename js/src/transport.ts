import { WS_SUBPROTOCOL, WS_SUBPROTOCOL_JWT_PREFIX } from './constants.js';
import { makeError } from './errors.js';
import type { WebSocketCtor, WebSocketLike } from './types.js';

const BINARY_BUFFER_LIMIT = 1024 * 1024;

export interface Transport {
  open(wsUrl: string, accessToken: string): Promise<void>;
  sendJson(message: unknown, timeoutMs: number): Promise<void>;
  sendBinary(data: Uint8Array, timeoutMs: number): Promise<void>;
  close(code?: number, reason?: string): void;
  onText: ((data: string) => void) | null;
  onBinary: ((data: Uint8Array) => void) | null;
  onClose: ((code: number, reason: string) => void) | null;
  onError: ((error: Error) => void) | null;
}

type TransportOpenError = Error & { code?: string; wsUrl?: string; closeCode?: number; closeReason?: string; phase?: 'connect' | 'connected' };

function asCloseReason(reason: unknown): string {
  if (typeof reason === 'string') return reason;
  if (reason instanceof Uint8Array) {
    try { return new TextDecoder().decode(reason); } catch { return ''; }
  }
  return '';
}

function buildOpenError(wsUrl: string, baseMessage: string, details: { closeCode?: number; closeReason?: string; phase?: 'connect' | 'connected' } = {}): TransportOpenError {
  const suffix: string[] = [];
  if (typeof details.closeCode === 'number') suffix.push(`close_code=${details.closeCode}`);
  if (details.closeReason) suffix.push(`close_reason=${details.closeReason}`);
  suffix.push(`ws_url=${wsUrl}`);
  const error = makeError('transport_open_failed', `${baseMessage} (${suffix.join(', ')})`) as TransportOpenError;
  Object.assign(error, { wsUrl, closeCode: details.closeCode, closeReason: details.closeReason, phase: details.phase });
  return error;
}

export function createTransport(WS: WebSocketCtor, connectTimeoutMs: number, _isDebugEnabled: () => boolean = () => false): Transport {
  let ws: WebSocketLike | null = null;
  let connectionGeneration = 0;
  const transport: Transport = {
    onText: null,
    onBinary: null,
    onClose: null,
    onError: null,

    open(wsUrl, accessToken) {
      return new Promise((resolve, reject) => {
        const socket = new WS(wsUrl, [WS_SUBPROTOCOL, `${WS_SUBPROTOCOL_JWT_PREFIX}${accessToken}`]);
        ws = socket;
        connectionGeneration++;
        if ('binaryType' in socket) socket.binaryType = 'arraybuffer';
        let settled = false;
        let opened = false;
        let openErrorMessage = 'WebSocket error';
        const timer = setTimeout(() => {
          socket.close();
          if (!settled) { settled = true; reject(makeError('transport_connect_timeout', `WebSocket connect timed out (ws_url=${wsUrl})`)); }
        }, connectTimeoutMs);
        socket.onopen = () => { clearTimeout(timer); if (!settled) { opened = true; settled = true; resolve(); } };
        socket.onerror = (event: unknown) => {
          const message = event instanceof Error ? event.message : 'WebSocket error';
          openErrorMessage = message;
          if (opened) transport.onError?.(buildOpenError(wsUrl, message, { phase: 'connected' }));
        };
        socket.onclose = (event) => {
          clearTimeout(timer);
          if (ws === socket) { ws = null; connectionGeneration++; }
          const reason = asCloseReason(event.reason);
          if (!opened && !settled) { settled = true; reject(buildOpenError(wsUrl, openErrorMessage, { closeCode: event.code, closeReason: reason, phase: 'connect' })); }
          transport.onClose?.(event.code, reason);
        };
        socket.onmessage = (event) => {
          const data = event.data;
          if (typeof data === 'string') { transport.onText?.(data); return; }
          if (data instanceof ArrayBuffer) { transport.onBinary?.(new Uint8Array(data)); return; }
          if (ArrayBuffer.isView(data)) { transport.onBinary?.(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); return; }
          if (typeof Blob !== 'undefined' && data instanceof Blob) {
            void data.arrayBuffer().then((buffer) => transport.onBinary?.(new Uint8Array(buffer)));
          }
        };
      });
    },

    async sendJson(message, timeoutMs) {
      const socket = ws;
      if (!socket) throw makeError('transport_send_timeout', 'No open connection');
      await sendWithTimeout(() => socket.send(JSON.stringify(message)), timeoutMs);
    },

    async sendBinary(data, timeoutMs) {
      const socket = ws;
      if (!socket) throw makeError('file_transfer_interrupted', 'No open connection');
      const generation = connectionGeneration;
      const deadline = Date.now() + timeoutMs;
      while (socket.bufferedAmount > BINARY_BUFFER_LIMIT) {
        if (ws !== socket || generation !== connectionGeneration) throw makeError('file_transfer_interrupted', 'Connection closed while waiting for binary backpressure');
        if (Date.now() >= deadline) throw makeError('transport_send_timeout', 'Binary send backpressure timed out');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (ws !== socket || generation !== connectionGeneration) throw makeError('file_transfer_interrupted', 'Connection closed before binary send');
      await sendWithTimeout(() => socket.send(data), Math.max(1, deadline - Date.now()));
    },

    close(code = 1000, reason = 'disconnect') {
      const socket = ws;
      ws = null;
      connectionGeneration++;
      socket?.close(code, reason);
    },
  };
  return transport;
}

function sendWithTimeout(send: () => void, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError('transport_send_timeout', 'Send timed out')), timeoutMs);
    try { send(); clearTimeout(timer); resolve(); }
    catch (error) { clearTimeout(timer); reject(makeError('transport_send_timeout', String(error))); }
  });
}
