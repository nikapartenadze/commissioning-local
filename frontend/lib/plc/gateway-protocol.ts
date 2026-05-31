/**
 * plc-gateway HTTP protocol — the contract shared by the gateway server
 * (gateway-server.ts) and the app-side client (lib/plc/gateway-client.ts).
 *
 * Phase 1 of the centralized-server modularity plan (CENTRAL-SERVER-DEPLOYMENT.md
 * §4): the gateway owns the live PLC connections, tag cache and network pollers;
 * the app owns the UI, API and SQLite. They talk over this small internal API
 * plus the existing :3102 broadcast seam (gateway -> app -> browsers).
 *
 * The gateway is intentionally DB-free. Anything that requires SQLite (resolving
 * an ioId to its owning subsystem, reading the IO tag set) is done in the app,
 * which passes the resolved values in the request body. This preserves the
 * single-writer SQLite invariant: the app is the only process that touches the
 * database.
 */

import type { IoTag, ConnectionStatus } from './plc-client';
import type { McmDescriptor } from '../mcm-registry';
import type { NetworkDeviceSnapshot } from './network';

export type { IoTag, ConnectionStatus, McmDescriptor, NetworkDeviceSnapshot };

/** Default internal port the gateway listens on. Override with GATEWAY_PORT. */
export const DEFAULT_GATEWAY_PORT = 3200;

/** Result of a connect attempt — mirrors mcm-registry.connectMcm(). */
export interface GatewayConnectResult {
  success: boolean;
  status: ConnectionStatus;
  error?: string;
  plcReachable?: boolean;
  tagsSuccessful?: number;
  tagsFailed?: number;
  failedTags?: Array<{ name: string; error: string }>;
}

/** Body for POST /mcm/:subsystemId/connect */
export interface GatewayConnectBody {
  name: string;
  ip: string;
  path: string;
  /**
   * Optional tag set to load atomically before connecting. The app folds the
   * loadMcmTags()+connectMcm() pair into one request here to avoid an ordering
   * race across the HTTP boundary.
   */
  tags?: IoTag[];
}

/** Body for POST /mcm/:subsystemId/load-tags */
export interface GatewayLoadTagsBody {
  tags: IoTag[];
}

/** Body for POST /mcm/:subsystemId/io/write */
export interface GatewayIoWriteBody {
  io: Pick<IoTag, 'id' | 'name' | 'tagType'>;
  value: number | 'toggle';
}

/** Body for POST /mcm/:subsystemId/io/read */
export interface GatewayIoReadBody {
  io: Pick<IoTag, 'id' | 'name' | 'tagType'>;
}

/** Result of a single-bit write/read — mirrors PlcClient.writeOutputBit(). */
export interface GatewayIoResult {
  /** Whether the owning MCM is currently connected (lets the app return 503). */
  connected: boolean;
  success: boolean;
  currentState?: boolean;
  error?: string;
}

/** Aggregate connection rollup — mirrors mcm-registry.getAggregateStatus(). */
export interface GatewayAggregate {
  anyConnected: boolean;
  connectedCount: number;
  totalCount: number;
  totalTagCount: number;
}

/**
 * Full snapshot returned by GET /state. The app polls this to back the
 * synchronous registry getters (getMcmStatus, getMcmTags, hasAnyMcm, ...) while
 * the real connections live in the gateway process.
 */
export interface GatewayState {
  mcms: McmDescriptor[];
  aggregate: GatewayAggregate;
  /** Union of every MCM's tags, each decorated with its subsystemId. */
  tags: Array<IoTag & { subsystemId: string }>;
  /** Latest network device snapshots across every MCM. */
  network: Array<NetworkDeviceSnapshot & { subsystemId: string }>;
}

/** GET /health */
export interface GatewayHealth {
  ok: boolean;
  service: 'plc-gateway';
  version: string;
  uptimeSec: number;
  mcmCount: number;
  connectedCount: number;
}
