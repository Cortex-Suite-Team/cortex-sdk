import type { Transport } from './transport.js';
import { SCHEMA_VERSION } from './constants.js';

export interface LivenessCallbacks {
  onStale(): void;
  getSessionId(): string | null;
  getChannelId(): string;
}

export interface LivenessController {
  start(): void;
  stop(): void;
  handlePong(heartbeatId: string): void;
}

export function createLiveness(
  transport: Transport,
  pingIntervalMs: number,
  pongTimeoutMs: number,
  staleThresholdMs: number,
  callbacks: LivenessCallbacks,
): LivenessController {
  let pingTimer: ReturnType<typeof setTimeout> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPongMs = Date.now();
  let pendingHeartbeatId: string | null = null;
  let running = false;

  function generateId(): string {
    return `hb_${Math.random().toString(36).slice(2, 10)}`;
  }

  function sendPing() {
    if (!running) return;

    // Check stale threshold
    if (Date.now() - lastPongMs > staleThresholdMs) {
      callbacks.onStale();
      return;
    }

    const heartbeatId = generateId();
    pendingHeartbeatId = heartbeatId;

    const sessionId = callbacks.getSessionId();
    const envelope: Record<string, unknown> = {
      type: 'system::ping',
      schema: SCHEMA_VERSION,
      payload: {
        heartbeat_id: heartbeatId,
        channel_id: callbacks.getChannelId(),
      },
      ts: new Date().toISOString(),
    };
    if (sessionId) envelope['session_id'] = sessionId;

    transport.sendJson(envelope, 5000).catch(() => {
      // send failure is handled by transport's onClose
    });

    pongTimer = setTimeout(() => {
      if (pendingHeartbeatId === heartbeatId && running) {
        // pong timeout — mark as stale if threshold also passed
        if (Date.now() - lastPongMs > staleThresholdMs) {
          callbacks.onStale();
        }
      }
    }, pongTimeoutMs);

    pingTimer = setTimeout(sendPing, pingIntervalMs);
  }

  return {
    start() {
      running = true;
      lastPongMs = Date.now();
      pingTimer = setTimeout(sendPing, pingIntervalMs);
    },

    stop() {
      running = false;
      if (pingTimer !== null) { clearTimeout(pingTimer); pingTimer = null; }
      if (pongTimer !== null) { clearTimeout(pongTimer); pongTimer = null; }
      pendingHeartbeatId = null;
    },

    handlePong(heartbeatId: string) {
      if (heartbeatId === pendingHeartbeatId) {
        pendingHeartbeatId = null;
        lastPongMs = Date.now();
        if (pongTimer !== null) { clearTimeout(pongTimer); pongTimer = null; }
      }
    },
  };
}
