import { Reactivity } from "@effect/experimental"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import type { SqliteConnectionConfig } from "@/domain"
import type { ActiveConnection, ColumnInfo, DriverService, QueryResult } from "@/drivers/types"
import { ConnectionError, QueryError } from "@/drivers/types"
import { describeError } from "@/errors/describe"

const ENGINE = "sqlite" as const

/**
 * Open a SQLite connection. The engine is a local file, so the only required
 * setting is `filename`; in-memory databases work when passing `":memory:"`.
 *
 * Unlike the network drivers, `SqliteClient.make` never fails on its own — an
 * unwritable path throws inside the client — so we map the catch-all directly
 * to `ConnectionError`.
 */
export const connectSqlite = (
  config: SqliteConnectionConfig
): Effect.Effect<ActiveConnection, ConnectionError, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const client = yield* SqliteClient.make({ filename: config.filename }).pipe(
      Scope.extend(scope),
      Effect.provide(Reactivity.layer),
      /*
       * `make` never fails in its error channel, so an unwritable path (or any
       * other constructor throw) arrives as a defect. `catchAllCause` folds
       * every cause — fail or die — into the typed `ConnectionError`.
       */
      Effect.catchAllCause(cause => Effect.fail(new ConnectionError({ engine: ENGINE, message: describeError(cause), cause })))
    )
    return { id: crypto.randomUUID(), engine: ENGINE, _client: client, _scope: scope }
  })

/** Run `sql` with positional `params`, mapping errors to `QueryError`. */
export const querySqlite = (
  conn: ActiveConnection,
  sql: string,
  params?: ReadonlyArray<unknown>
): Effect.Effect<QueryResult, QueryError> =>
  Effect.gen(function* () {
    const rows = yield* (conn._client as SqliteClient.SqliteClient).unsafe<Record<string, unknown>>(sql, params).pipe(
      Effect.mapError(
        cause =>
          new QueryError({
            engine: ENGINE,
            message: describeError(cause),
            cause,
          })
      )
    )
    return toQueryResult(rows)
  })

/** Close the SQLite database owned by the handle. */
export const disconnectSqlite = (conn: ActiveConnection): Effect.Effect<void> =>
  Scope.close(conn._scope as Scope.CloseableScope, Exit.void)

/** Report whether the SQLite file is still open. */
export const isConnectedSqlite = (conn: ActiveConnection): Effect.Effect<boolean> =>
  querySqlite(conn, "SELECT 1 AS one", []).pipe(
    Effect.as(true),
    Effect.catchAll(() => Effect.succeed(false))
  )

const toQueryResult = (rows: ReadonlyArray<Record<string, unknown>>): QueryResult => {
  const columns: ReadonlyArray<ColumnInfo> =
    rows.length > 0
      ? Object.keys(rows[0]!).map(name => ({
          name,
        }))
      : []
  return { columns, rows }
}

export class SqliteDriver extends Context.Tag("SqliteDriver")<SqliteDriver, DriverService<SqliteConnectionConfig>>() {}

export namespace SqliteDriver {
  /** `SqliteDriver` service backed by @effect/sql-sqlite-bun. */
  export const layer: Layer.Layer<SqliteDriver> = Layer.succeed(SqliteDriver, {
    connect: connectSqlite,
    query: querySqlite,
    disconnect: disconnectSqlite,
    isConnected: isConnectedSqlite,
  })
}
