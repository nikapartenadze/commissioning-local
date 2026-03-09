/**
 * libplctag Node.js/TypeScript bindings
 *
 * This module provides FFI bindings to the native libplctag C library
 * for communicating with Allen-Bradley PLCs via Ethernet/IP.
 *
 * @example
 * ```typescript
 * import {
 *   initLibrary,
 *   createTag,
 *   plc_tag_read,
 *   plc_tag_get_int32,
 *   plc_tag_destroy,
 *   PlcTagStatus,
 *   isStatusOk,
 * } from './lib/plc';
 *
 * // Initialize the library
 * initLibrary();
 *
 * // Create a tag
 * const tag = createTag({
 *   gateway: '192.168.1.100',
 *   path: '1,0',
 *   name: 'MyTag',
 *   elemSize: 4,
 * });
 *
 * if (tag >= 0) {
 *   // Read the tag
 *   const status = plc_tag_read(tag, 5000);
 *   if (isStatusOk(status)) {
 *     const value = plc_tag_get_int32(tag, 0);
 *     console.log('Tag value:', value);
 *   }
 *
 *   // Clean up
 *   plc_tag_destroy(tag);
 * }
 * ```
 */

// Re-export everything from libplctag
export * from "./libplctag";

// Re-export types
export * from "./types";

// Re-export WebSocket server
export {
  PlcWebSocketServer,
  startPlcWebSocketServer,
  getPlcWebSocketServer,
  stopPlcWebSocketServer,
  type PlcWebSocketServerOptions,
  type PlcWebSocketMessage,
  type MessageType,
  type UpdateStateMessage,
  type UpdateIOMessage,
  type ConfigurationReloadingMessage,
  type ConfigurationReloadedMessage,
  type TestingStateChangedMessage,
  type CommentUpdateMessage,
  type NetworkStatusChangedMessage,
  type ErrorEventMessage
} from './websocket-server';

// Re-export WebSocket client
export {
  usePlcWebSocket,
  PlcWebSocketClient,
  type IOUpdate,
  type ConfigurationEvent,
  type CommentUpdate,
  type NetworkStatusUpdate,
  type ErrorEvent,
  type WebSocketConnectionOptions,
  type WebSocketConnection
} from './websocket-client';

// Re-export Tag Reader Service
export {
  TagReaderService,
  createTagReader,
  type TagState,
  type TagValueChangeEvent,
  type TagReaderConfig,
  type TagReaderEvents,
} from './tag-reader';

// Re-export PLC Client
export {
  PlcClient,
  createPlcClient,
  type IoTag,
  type PlcConnectionConfig,
  type PlcClientConfig,
  type ConnectionStatus,
  type PlcClientEvents,
} from './plc-client';
