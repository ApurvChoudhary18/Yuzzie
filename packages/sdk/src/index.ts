/**
 * `@yuzie/sdk` — the typed client every Yuzie front end consumes (SPEC.md §13.1).
 *
 * This entry is platform-neutral: it needs only `fetch` and `WebSocket`, which
 * browsers and Node 22+ both provide, and imports nothing Node-specific. The
 * credential store (env → keychain → file, §13.3) needs the filesystem, so it
 * lives in `@yuzie/sdk/node`.
 */
export {
  AuthenticationError,
  BoardError,
  ConflictError,
  InternalError,
  NotFoundError,
  OfflineError,
  PermissionError,
  RateLimitError,
  ValidationError,
  WipLimitError,
} from '@yuzie/core'
export {
  Board,
  type BoardEventMap,
  BoardsResource,
  type CardFilter,
  type CardInput,
  CardsResource,
  CommentsResource,
  type ConflictEvent,
  MembersResource,
  type MoveOptions,
  matchColumn,
  type OfflineMode,
  type RejectedEvent,
  type SyncReport,
  stateFromSnapshot,
} from './board.js'
export {
  type CacheLike,
  createMemoryOutbox,
  type OutboxEntryLike,
  type OutboxLike,
  type OutboxOpLike,
  type SyncStateLike,
} from './cache.js'
export {
  type ClientOptions,
  type ConnectOptions,
  createClient,
  DEFAULT_BASE_URL,
  type DevicePollResult,
  type ServerHealth,
  Yuzie,
  type YuzieClient,
} from './client.js'
export {
  createHttp,
  errorFromResponse,
  type Http,
  type HttpMethod,
  type HttpOptions,
} from './http.js'
export type {
  FetchLike,
  RequestInitLike,
  ResponseLike,
  WebSocketFactory,
  WebSocketLike,
} from './platform.js'
export {
  type ConnectionStatus,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  reconnectDelayMs,
  streamUrl,
} from './realtime.js'
