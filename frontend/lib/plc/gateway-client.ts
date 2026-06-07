/**
 * gateway-client — app-side HTTP client for the plc-gateway service.
 *
 * Used only when PLC_MODE=remote (the split deployment). Every call is
 * defensive: if the gateway is unreachable the client returns a well-formed
 * failure/empty value instead of throwing, so an app restart that briefly
 * races the gateway, or a gateway hiccup, degrades to "not connected" in the
 * UI rather than crashing a request handler.
 *
 * See lib/plc/gateway-protocol.ts for the contract.
 */

import {
  DEFAULT_GATEWAY_PORT,
  type GatewayState,
  type GatewayConnectResult,
  type GatewayIoResult,
  type GatewayHealth,
  type IoTag,
  type McmDescriptor,
} from './gateway-protocol';
import type {
  TypedTagWrite,
  TypedTagRead,
  TypedWriteResult,
  TypedReadResult,
  TypedBatchResult,
  HammerWrite,
  HammerResult,
} from '@/lib/mcm-registry';

const GATEWAY_URL =
  process.env.GATEWAY_URL || `http://127.0.0.1:${process.env.GATEWAY_PORT || DEFAULT_GATEWAY_PORT}`;

/** Per-request timeout. PLC connect can be slow, so callers can override. */
const DEFAULT_TIMEOUT_MS = 8_000;

export function getGatewayUrl(): string {
  return GATEWAY_URL;
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  timeoutMs: number,
  fallback: T
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${GATEWAY_URL}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      // The gateway returns structured JSON even on 4xx/5xx; try to surface it.
      try {
        return (await res.json()) as T;
      } catch {
        return fallback;
      }
    }
    return (await res.json()) as T;
  } catch (err) {
    // Network error / abort / gateway down — degrade gracefully.
    if (process.env.NODE_ENV === 'development') {
      console.warn(`[gateway-client] ${method} ${path} failed:`, err instanceof Error ? err.message : err);
    }
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

const EMPTY_STATE: GatewayState = {
  mcms: [],
  aggregate: { anyConnected: false, connectedCount: 0, totalCount: 0, totalTagCount: 0 },
  tags: [],
  network: [],
};

export const gatewayClient = {
  baseUrl: GATEWAY_URL,

  async health(): Promise<GatewayHealth | null> {
    return request<GatewayHealth | null>('GET', '/health', undefined, 3_000, null);
  },

  /** Full snapshot used to refresh the app-side read cache. */
  async getState(): Promise<GatewayState> {
    return request<GatewayState>('GET', '/state', undefined, 5_000, EMPTY_STATE);
  },

  async loadTags(subsystemId: string, tags: IoTag[]): Promise<{ success: boolean }> {
    return request<{ success: boolean }>(
      'POST',
      `/mcm/${encodeURIComponent(subsystemId)}/load-tags`,
      { tags },
      DEFAULT_TIMEOUT_MS,
      { success: false }
    );
  },

  async connect(
    subsystemId: string,
    name: string,
    config: { ip: string; path: string },
    tags?: IoTag[]
  ): Promise<GatewayConnectResult> {
    return request<GatewayConnectResult>(
      'POST',
      `/mcm/${encodeURIComponent(subsystemId)}/connect`,
      { name, ip: config.ip, path: config.path, tags },
      35_000, // PLC connect + tag registration can take ~30s
      { success: false, status: 'error', error: 'plc-gateway unreachable' }
    );
  },

  async disconnect(subsystemId: string): Promise<{ success: boolean }> {
    return request<{ success: boolean }>(
      'POST',
      `/mcm/${encodeURIComponent(subsystemId)}/disconnect`,
      {},
      DEFAULT_TIMEOUT_MS,
      { success: false }
    );
  },

  async dispose(subsystemId: string): Promise<{ success: boolean }> {
    return request<{ success: boolean }>(
      'POST',
      `/mcm/${encodeURIComponent(subsystemId)}/dispose`,
      {},
      DEFAULT_TIMEOUT_MS,
      { success: false }
    );
  },

  async getStatus(subsystemId: string): Promise<McmDescriptor | null> {
    return request<McmDescriptor | null>(
      'GET',
      `/mcm/${encodeURIComponent(subsystemId)}/status`,
      undefined,
      4_000,
      null
    );
  },

  async writeIo(
    subsystemId: string,
    io: Pick<IoTag, 'id' | 'name' | 'tagType'>,
    value: number | 'toggle'
  ): Promise<GatewayIoResult> {
    return request<GatewayIoResult>(
      'POST',
      `/mcm/${encodeURIComponent(subsystemId)}/io/write`,
      { io, value },
      DEFAULT_TIMEOUT_MS,
      { connected: false, success: false, error: 'plc-gateway unreachable' }
    );
  },

  async readIo(
    subsystemId: string,
    io: Pick<IoTag, 'id' | 'name' | 'tagType'>
  ): Promise<GatewayIoResult> {
    return request<GatewayIoResult>(
      'POST',
      `/mcm/${encodeURIComponent(subsystemId)}/io/read`,
      { io },
      DEFAULT_TIMEOUT_MS,
      { connected: false, success: false, error: 'plc-gateway unreachable' }
    );
  },

  async writeTags(
    subsystemId: string,
    writes: TypedTagWrite[]
  ): Promise<TypedBatchResult<TypedWriteResult>> {
    return request<TypedBatchResult<TypedWriteResult>>(
      'POST',
      `/mcm/${encodeURIComponent(subsystemId)}/tags/write`,
      { writes },
      15_000,
      { connected: false, results: writes.map((w) => ({ name: w.name, success: false, error: 'plc-gateway unreachable' })) }
    );
  },

  async readTags(
    subsystemId: string,
    reads: TypedTagRead[]
  ): Promise<TypedBatchResult<TypedReadResult>> {
    return request<TypedBatchResult<TypedReadResult>>(
      'POST',
      `/mcm/${encodeURIComponent(subsystemId)}/tags/read`,
      { reads },
      15_000,
      { connected: false, results: reads.map((r) => ({ name: r.name, success: false, error: 'plc-gateway unreachable' })) }
    );
  },

  async hammerWrite(
    subsystemId: string,
    deviceName: string,
    writes: HammerWrite[]
  ): Promise<HammerResult> {
    return request<HammerResult>(
      'POST',
      `/mcm/${encodeURIComponent(subsystemId)}/tags/hammer-write`,
      { deviceName, writes },
      8_000, // the hammer loop runs ~1s in the gateway
      { connected: false, success: false, iterations: 0, writes: [], error: 'plc-gateway unreachable' }
    );
  },

  /** Phase 1.1: open/refresh the gateway-hosted VFD wizard reader for one device. */
  async wizardOpen(
    subsystemId: string,
    deviceName: string
  ): Promise<{ ok: boolean; tagCount?: number; failedTags?: string[]; error?: string }> {
    return request<{ ok: boolean; tagCount?: number; failedTags?: string[]; error?: string }>(
      'POST',
      `/mcm/${encodeURIComponent(subsystemId)}/wizard/open`,
      { deviceName },
      15_000, // first open creates 8 persistent handles
      { ok: false, error: 'plc-gateway unreachable' }
    );
  },

  /** Phase 1.1: close the gateway-hosted VFD wizard reader for one device. */
  async wizardClose(subsystemId: string, deviceName: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      'POST',
      `/mcm/${encodeURIComponent(subsystemId)}/wizard/close`,
      { deviceName },
      DEFAULT_TIMEOUT_MS,
      { ok: false }
    );
  },
};

export type GatewayClient = typeof gatewayClient;
