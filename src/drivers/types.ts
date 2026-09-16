import { Data, Effect, Scope } from "effect"
import type { ConnectionConfig, Engine } from "@/domain"

/**
 * Metadata about one column of a query result. The name always comes from the
 * engine itself; `type` is populated lazily by the schema inspector, so drivers
 * only ever fill in the name.
 */
export interface ColumnInfo {
  readonly name: string
  readonly type?: string
}

/**
 * The result of a query: ordered column metadata (derived from the first row
 * when the engine does not report columns) plus the raw rows as records keyed
 * by column name.
 */
export interface QueryResult {
  readonly columns: ReadonlyArray<ColumnInfo>
  readonly rows: ReadonlyArray<Record<string, unknown>>
}

/**
 * A live database connection. `ActiveConnection` is an opaque handle: callers
 * pass it back into `query`/`disconnect`/`isConnected`, but never reach into
 * the client or scope themselves. The engine field lets the facade dispatch to
 * the right driver without holding a reference to the owning connection.
 */
export interface ActiveConnection {
  readonly id: string
  readonly engine: Engine
  /* @internal Opaque @effect/sql client (never accessed by `DatabaseDriver`). */
  readonly _client: unknown
  /* @internal CloseScope that owns the client; `disconnect` closes it. */
  readonly _scope: unknown
}

/**
 * Raised when a connection cannot be established: wrong host, wrong port,
 * unreachable host, authentication failure, malformed config, or the engine
 * refusing to accept the session.
 */
export class ConnectionError extends Data.TaggedError("ConnectionError")<{
  readonly engine: Engine
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Raised when a query against a live connection fails — bad SQL, dead session,
 * permission errors, or a lost connection mid-query.
 */
export class QueryError extends Data.TaggedError("QueryError")<{
  readonly engine: Engine
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * The service contract every engine driver implements. The facade
 * `DatabaseDriver` exposes the same shape, dispatching to the matching engine's
 * driver based on `config.engine` / `conn.engine`.
 *
 * `connect` hands back the handle inside the caller's scope: the caller (or the
 * scope that wraps the `connect` effect) owns the lifecycle and must eventually
 * call `disconnect`, otherwise the connection leaks.
 */
export interface DriverService<TConfig extends ConnectionConfig = ConnectionConfig> {
  readonly connect: (config: TConfig) => Effect.Effect<ActiveConnection, ConnectionError, Scope.Scope>
  readonly query: (
    conn: ActiveConnection,
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Effect.Effect<QueryResult, QueryError>
  readonly disconnect: (conn: ActiveConnection) => Effect.Effect<void>
  readonly isConnected: (conn: ActiveConnection) => Effect.Effect<boolean>
}