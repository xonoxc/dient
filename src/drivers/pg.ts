import { Reactivity } from "@effect/experimental"
import { PgClient } from "@effect/sql-pg"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import type { PostgresConnectionConfig } from "@/domain"
import type { ActiveConnection, ColumnInfo, DriverService, QueryResult } from "@/drivers/types"
import { ConnectionError, QueryError } from "@/drivers/types"

const ENGINE = "postgres" as const

/**
 * Open a PostgreSQL connection from a `PostgresConnectionConfig`, returning an
 * opaque `ActiveConnection` handle.
 *
 * The `@effect/sql-pg` constructor requires `Scope` (for the connection pool)
 * and `Reactivity` (for client-side change propagation). We mint our own scope,
 * extend the constructor through it, and hand the scope back inside the handle
 * so `disconnect` can tear the pool down exactly once.
 *
 * Every failure mode — bad host, refused port, bad credentials, unreachable
 * network — surfaces as the same typed `ConnectionError`, so callers never have
 * to inspect driver-specific exceptions.
 */
export const connectPg = (
  config: PostgresConnectionConfig,
): Effect.Effect<ActiveConnection, ConnectionError, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const client = yield* PgClient.make({
      host: config.host ?? "localhost",
      port: config.port ?? 5432,
      database: config.defaultDatabase ?? "postgres",
      username: config.user ?? "postgres",
      password: config.password === undefined ? undefined : Redacted.make(config.password),
      connectTimeout: "5 seconds",
    }).pipe(
      Scope.extend(scope),
      Effect.provide(Reactivity.layer),
      Effect.mapError((cause) => new ConnectionError({ engine: ENGINE, message: String(cause), cause })),
    )
    return { id: crypto.randomUUID(), engine: ENGINE, _client: client, _scope: scope }
  })

/**
 * Run `sql` against a live connection. Parameters are bound positionally via
 * `unsafe`, and the engine returns raw rows keyed by column name; column
 * metadata is derived from the keys of the first row.
 */
export const queryPg = (
  conn: ActiveConnection,
  sql: string,
  params?: ReadonlyArray<unknown>,
): Effect.Effect<QueryResult, QueryError> =>
  Effect.gen(function* () {
    const rows = yield* (conn._client as PgClient.PgClient).unsafe<Record<string, unknown>>(sql, params).pipe(
      Effect.mapError((cause) => new QueryError({ engine: ENGINE, message: String(cause), cause })),
    )
    return toQueryResult(rows)
  })

/** Close the connection pool owned by the handle. Subsequent queries will fail. */
export const disconnectPg = (conn: ActiveConnection): Effect.Effect<void> =>
  Scope.close(conn._scope as Scope.CloseableScope, Exit.void)

/**
 * Probe the connection with `SELECT 1`. Report `false` for any failure instead
 * of raising, so the UI can render a disconnected indicator without wrapping
 * every call in try/catch.
 */
export const isConnectedPg = (conn: ActiveConnection): Effect.Effect<boolean> =>
  queryPg(conn, "SELECT 1", []).pipe(
    Effect.as(true),
    Effect.catchAll(() => Effect.succeed(false)),
  )

const toQueryResult = (rows: ReadonlyArray<Record<string, unknown>>): QueryResult => {
  const columns: ReadonlyArray<ColumnInfo> =
    rows.length > 0 ? Object.keys(rows[0]!).map((name) => ({ name })) : []
  return { columns, rows }
}

export class PgDriver extends Context.Tag("PgDriver")<
  PgDriver,
  DriverService<PostgresConnectionConfig>
>() {}

export namespace PgDriver {
  /** `PgDriver` service backed by @effect/sql-pg. */
  export const layer: Layer.Layer<PgDriver> = Layer.succeed(PgDriver, {
    connect: connectPg,
    query: queryPg,
    disconnect: disconnectPg,
    isConnected: isConnectedPg,
  })
}