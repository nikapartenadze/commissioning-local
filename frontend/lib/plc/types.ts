/**
 * TypeScript types for libplctag PLC communication library
 */

// ============================================================================
// Status Codes
// ============================================================================

/**
 * libplctag status codes returned by library functions
 */
export const PlcTagStatus = {
  /** Operation is pending (async) */
  PLCTAG_STATUS_PENDING: 1,
  /** Operation completed successfully */
  PLCTAG_STATUS_OK: 0,
  /** Operation was aborted */
  PLCTAG_ERR_ABORT: -1,
  /** Bad configuration */
  PLCTAG_ERR_BAD_CONFIG: -2,
  /** Bad connection to PLC */
  PLCTAG_ERR_BAD_CONNECTION: -3,
  /** Bad data format */
  PLCTAG_ERR_BAD_DATA: -4,
  /** Bad device */
  PLCTAG_ERR_BAD_DEVICE: -5,
  /** Bad gateway */
  PLCTAG_ERR_BAD_GATEWAY: -6,
  /** Bad parameter */
  PLCTAG_ERR_BAD_PARAM: -7,
  /** Bad reply from PLC */
  PLCTAG_ERR_BAD_REPLY: -8,
  /** Bad status */
  PLCTAG_ERR_BAD_STATUS: -9,
  /** Close error */
  PLCTAG_ERR_CLOSE: -10,
  /** Create error */
  PLCTAG_ERR_CREATE: -11,
  /** Duplicate tag */
  PLCTAG_ERR_DUPLICATE: -12,
  /** Encode error */
  PLCTAG_ERR_ENCODE: -13,
  /** Mutex destroy error */
  PLCTAG_ERR_MUTEX_DESTROY: -14,
  /** Mutex init error */
  PLCTAG_ERR_MUTEX_INIT: -15,
  /** Mutex lock error */
  PLCTAG_ERR_MUTEX_LOCK: -16,
  /** Mutex unlock error */
  PLCTAG_ERR_MUTEX_UNLOCK: -17,
  /** Operation not allowed */
  PLCTAG_ERR_NOT_ALLOWED: -18,
  /** Tag not found */
  PLCTAG_ERR_NOT_FOUND: -19,
  /** Not implemented */
  PLCTAG_ERR_NOT_IMPLEMENTED: -20,
  /** No data available */
  PLCTAG_ERR_NO_DATA: -21,
  /** No match */
  PLCTAG_ERR_NO_MATCH: -22,
  /** Out of memory */
  PLCTAG_ERR_NO_MEM: -23,
  /** No resources available */
  PLCTAG_ERR_NO_RESOURCES: -24,
  /** Null pointer */
  PLCTAG_ERR_NULL_PTR: -25,
  /** Open error */
  PLCTAG_ERR_OPEN: -26,
  /** Out of bounds */
  PLCTAG_ERR_OUT_OF_BOUNDS: -27,
  /** Read error */
  PLCTAG_ERR_READ: -28,
  /** Remote error from PLC */
  PLCTAG_ERR_REMOTE_ERR: -29,
  /** Thread create error */
  PLCTAG_ERR_THREAD_CREATE: -30,
  /** Thread join error */
  PLCTAG_ERR_THREAD_JOIN: -31,
  /** Operation timed out */
  PLCTAG_ERR_TIMEOUT: -32,
  /** Data too large */
  PLCTAG_ERR_TOO_LARGE: -33,
  /** Data too small */
  PLCTAG_ERR_TOO_SMALL: -34,
  /** Unsupported operation */
  PLCTAG_ERR_UNSUPPORTED: -35,
  /** Winsock error (Windows only) */
  PLCTAG_ERR_WINSOCK: -36,
  /** Write error */
  PLCTAG_ERR_WRITE: -37,
  /** Partial operation */
  PLCTAG_ERR_PARTIAL: -38,
  /** Resource is busy */
  PLCTAG_ERR_BUSY: -39,
} as const;

export type PlcTagStatusCode = (typeof PlcTagStatus)[keyof typeof PlcTagStatus];

// ============================================================================
// Event Types
// ============================================================================

/**
 * Event types for tag callbacks
 */
export const PlcTagEvent = {
  /** Tag was created */
  PLCTAG_EVENT_CREATED: 7,
  /** Read operation started */
  PLCTAG_EVENT_READ_STARTED: 1,
  /** Read operation completed */
  PLCTAG_EVENT_READ_COMPLETED: 2,
  /** Write operation started */
  PLCTAG_EVENT_WRITE_STARTED: 3,
  /** Write operation completed */
  PLCTAG_EVENT_WRITE_COMPLETED: 4,
  /** Operation was aborted */
  PLCTAG_EVENT_ABORTED: 5,
  /** Tag was destroyed */
  PLCTAG_EVENT_DESTROYED: 6,
} as const;

export type PlcTagEventType = (typeof PlcTagEvent)[keyof typeof PlcTagEvent];

// ============================================================================
// Debug Levels
// ============================================================================

/**
 * Debug levels for logging
 */
export const PlcTagDebugLevel = {
  /** No debug output */
  PLCTAG_DEBUG_NONE: 0,
  /** Error messages only */
  PLCTAG_DEBUG_ERROR: 1,
  /** Warnings and errors */
  PLCTAG_DEBUG_WARN: 2,
  /** Informational messages */
  PLCTAG_DEBUG_INFO: 3,
  /** Detailed debug info */
  PLCTAG_DEBUG_DETAIL: 4,
  /** Everything (verbose) */
  PLCTAG_DEBUG_SPEW: 5,
} as const;

export type PlcTagDebugLevelType = (typeof PlcTagDebugLevel)[keyof typeof PlcTagDebugLevel];

// ============================================================================
// Tag Configuration
// ============================================================================

/**
 * Configuration for creating a PLC tag
 */
export interface PlcTagConfig {
  /** Protocol to use (e.g., 'ab_eip' for Allen-Bradley Ethernet/IP) */
  protocol?: string;
  /** IP address or hostname of the PLC */
  gateway: string;
  /** Path to the target (e.g., '1,0' for slot 0 on backplane 1) */
  path: string;
  /** CPU type (e.g., 'logix' for ControlLogix/CompactLogix) */
  cpu?: string;
  /** Tag name in the PLC */
  name: string;
  /** Element size in bytes (1 for SINT/BOOL, 2 for INT, 4 for DINT/REAL) */
  elemSize?: number;
  /** Number of elements (for arrays) */
  elemCount?: number;
  /** Connection timeout in milliseconds */
  timeout?: number;
}

/**
 * Build an attribute string from PlcTagConfig
 */
export function buildAttributeString(config: PlcTagConfig): string {
  const parts: string[] = [];

  parts.push(`protocol=${config.protocol ?? "ab_eip"}`);
  parts.push(`gateway=${config.gateway}`);
  parts.push(`path=${config.path}`);
  parts.push(`cpu=${config.cpu ?? "logix"}`);
  parts.push(`elem_size=${config.elemSize ?? 1}`);
  parts.push(`elem_count=${config.elemCount ?? 1}`);
  parts.push(`name=${config.name}`);

  return parts.join("&");
}

// ============================================================================
// Error Handling
// ============================================================================

/**
 * Map of status codes to human-readable error messages
 */
export const StatusCodeMessages: Record<number, string> = {
  [PlcTagStatus.PLCTAG_STATUS_PENDING]: "Operation pending",
  [PlcTagStatus.PLCTAG_STATUS_OK]: "OK",
  [PlcTagStatus.PLCTAG_ERR_ABORT]: "Operation aborted",
  [PlcTagStatus.PLCTAG_ERR_BAD_CONFIG]: "Bad configuration",
  [PlcTagStatus.PLCTAG_ERR_BAD_CONNECTION]: "Bad connection",
  [PlcTagStatus.PLCTAG_ERR_BAD_DATA]: "Bad data",
  [PlcTagStatus.PLCTAG_ERR_BAD_DEVICE]: "Bad device",
  [PlcTagStatus.PLCTAG_ERR_BAD_GATEWAY]: "Bad gateway",
  [PlcTagStatus.PLCTAG_ERR_BAD_PARAM]: "Bad parameter",
  [PlcTagStatus.PLCTAG_ERR_BAD_REPLY]: "Bad reply",
  [PlcTagStatus.PLCTAG_ERR_BAD_STATUS]: "Bad status",
  [PlcTagStatus.PLCTAG_ERR_CLOSE]: "Close error",
  [PlcTagStatus.PLCTAG_ERR_CREATE]: "Create error",
  [PlcTagStatus.PLCTAG_ERR_DUPLICATE]: "Duplicate tag",
  [PlcTagStatus.PLCTAG_ERR_ENCODE]: "Encode error",
  [PlcTagStatus.PLCTAG_ERR_MUTEX_DESTROY]: "Mutex destroy error",
  [PlcTagStatus.PLCTAG_ERR_MUTEX_INIT]: "Mutex init error",
  [PlcTagStatus.PLCTAG_ERR_MUTEX_LOCK]: "Mutex lock error",
  [PlcTagStatus.PLCTAG_ERR_MUTEX_UNLOCK]: "Mutex unlock error",
  [PlcTagStatus.PLCTAG_ERR_NOT_ALLOWED]: "Not allowed",
  [PlcTagStatus.PLCTAG_ERR_NOT_FOUND]: "Not found",
  [PlcTagStatus.PLCTAG_ERR_NOT_IMPLEMENTED]: "Not implemented",
  [PlcTagStatus.PLCTAG_ERR_NO_DATA]: "No data",
  [PlcTagStatus.PLCTAG_ERR_NO_MATCH]: "No match",
  [PlcTagStatus.PLCTAG_ERR_NO_MEM]: "Out of memory",
  [PlcTagStatus.PLCTAG_ERR_NO_RESOURCES]: "No resources",
  [PlcTagStatus.PLCTAG_ERR_NULL_PTR]: "Null pointer",
  [PlcTagStatus.PLCTAG_ERR_OPEN]: "Open error",
  [PlcTagStatus.PLCTAG_ERR_OUT_OF_BOUNDS]: "Out of bounds",
  [PlcTagStatus.PLCTAG_ERR_READ]: "Read error",
  [PlcTagStatus.PLCTAG_ERR_REMOTE_ERR]: "Remote error",
  [PlcTagStatus.PLCTAG_ERR_THREAD_CREATE]: "Thread create error",
  [PlcTagStatus.PLCTAG_ERR_THREAD_JOIN]: "Thread join error",
  [PlcTagStatus.PLCTAG_ERR_TIMEOUT]: "Timeout",
  [PlcTagStatus.PLCTAG_ERR_TOO_LARGE]: "Too large",
  [PlcTagStatus.PLCTAG_ERR_TOO_SMALL]: "Too small",
  [PlcTagStatus.PLCTAG_ERR_UNSUPPORTED]: "Unsupported",
  [PlcTagStatus.PLCTAG_ERR_WINSOCK]: "Winsock error",
  [PlcTagStatus.PLCTAG_ERR_WRITE]: "Write error",
  [PlcTagStatus.PLCTAG_ERR_PARTIAL]: "Partial operation",
  [PlcTagStatus.PLCTAG_ERR_BUSY]: "Busy",
};

/**
 * Get a human-readable error message for a status code
 */
export function getStatusMessage(status: number): string {
  return StatusCodeMessages[status] ?? `Unknown error (${status})`;
}

/**
 * Check if a status code indicates success
 */
export function isStatusOk(status: number): boolean {
  return status === PlcTagStatus.PLCTAG_STATUS_OK;
}

/**
 * Check if a status code indicates a pending operation
 */
export function isStatusPending(status: number): boolean {
  return status === PlcTagStatus.PLCTAG_STATUS_PENDING;
}

/**
 * Check if a status code indicates an error
 */
export function isStatusError(status: number): boolean {
  return status < 0;
}

// ============================================================================
// Tag Handle Type
// ============================================================================

/**
 * A tag handle returned by plc_tag_create
 * Positive values are valid handles, negative values are error codes
 */
export type TagHandle = number;

/**
 * Check if a tag handle is valid
 */
export function isValidTagHandle(handle: TagHandle): boolean {
  return handle >= 0;
}

// ============================================================================
// WebSocket Message Types
// ============================================================================

export interface UpdateStateMessage {
  type: 'UpdateState'
  id: number
  state: boolean
}

export interface UpdateIOMessage {
  type: 'UpdateIO'
  id: number
  result: string
  state: string
  timestamp: string
  comments: string
}

export interface CommentUpdateMessage {
  type: 'CommentUpdate'
  ioId: number
  comments: string
}

export interface NetworkStatusChangedMessage {
  type: 'NetworkStatusChanged'
  moduleName: string
  isOnline?: boolean
  status?: string
  reconnecting?: boolean
  affectedTags?: number[]
  errorCount?: number
}

export interface ErrorEventMessage {
  type: 'Error'
  message: string
  severity: 'warning' | 'error' | 'critical'
}

export interface TestingStateChangedMessage {
  type: 'TestingStateChanged'
  isTesting: boolean
  isTestingUsers?: string[]
  changedUser?: string
}

export interface ConfigReloadMessage {
  type: 'ConfigReload'
  status: 'reloading' | 'reloaded'
}

export interface TagStatusUpdateMessage {
  type: 'TagStatusUpdate'
  totalTags: number
  successfulTags: number
  failedTags: number
  hasErrors: boolean
  connected: boolean
}

export interface CloudConnectionChangedMessage {
  type: 'CloudConnectionChanged'
  connected: boolean
  state: 'connected' | 'reconnecting' | 'disconnected'
}

export interface L2CellUpdatedMessage {
  type: 'L2CellUpdated'
  cloudDeviceId: number
  cloudColumnId: number
  localDeviceId: number
  localColumnId: number
  value: string | null
  version: number
  updatedBy: string | null
  updatedAt: string
}

export type PlcWebSocketMessage =
  | UpdateStateMessage
  | UpdateIOMessage
  | CommentUpdateMessage
  | NetworkStatusChangedMessage
  | ErrorEventMessage
  | TestingStateChangedMessage
  | ConfigReloadMessage
  | TagStatusUpdateMessage
  | CloudConnectionChangedMessage
  | L2CellUpdatedMessage
