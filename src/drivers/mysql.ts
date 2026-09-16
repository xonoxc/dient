import { Reactivity } from "@effect/experimental"
import { MysqlClient } from "@effect/sql-mysql2"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import type { MysqlConnectionConfig } from "@/domain"
import type { ActiveConnection, ColumnInfo, DriverService, QueryResult } from "@/drivers/types"
import { ConnectionError, QueryError } from "@/drivers/types"

const ENGINE = "mysql" as const

/**
 * Open a MySQL/MariaDB connection from a `MysqlConnectionConfig`. Mirrors the
 * Postgres driver: a private scope owns the `@effect/sql-mysql2` pool, and the
 * scope travels inside the returned handle for `disconnect` to close.
 *
 * `defaultDatabase` is optional; when omitted MySQL2 connects without selecting
 * a schema and queries can address tables with fully qualified names.
 */
export const connectMysql = (
  config: MysqlConnectionConfig,
): Effect.Effect<ActiveConnection, ConnectionError, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const client = yield* MysqlClient.make({
      host: config.host ?? "localhost",
      port: config.port ?? 3306,
      database: config.defaultDatabase,
      username: config.user ?? "root",
      password: config.password === undefined ? undefined : Redacted.make(config.password),
    }).pipe(
      Scope.extend(scope),
      Effect.provide(Reactivity.layer),
      Effect.mapError((cause) => new ConnectionError({ engine: ENGINE, message: String(cause), cause })),
    )
    return { id: crypto.randomUUID(), engine: ENGINE, _client: client, _scope: scope }
  })

/** Run `sql` with positional `params`, mapping driver errors to `QueryError`. */
export const queryMysql = (
  conn: ActiveConnection,
  sql: string,
  params?: ReadonlyArray<unknown>,
): Effect.Effect<QueryResult, QueryError> =>
  Effect.gen(function* () {
    const rows = yield* (conn._client as MysqlClient.MysqlClient).unsafe<Record<string, unknown>>(sql, params).pipe(
      Effect.mapError((cause) => new QueryError({ engine: ENGINE, message: String(cause), cause })),
    )
    return toQueryResult(rows)
  })

/** Close the MySQL pool owned by the handle. */
export const disconnectMysql = (conn: ActiveConnection): Effect.Effect<void> =>
  Scope.close(conn._scope as Scope.CloseableScope, Exit.void)

/** `SELECT 1` probe; any failure reports `false`. */
export const isConnectedMysql = (conn: ActiveConnection): Effect.Effect<boolean> =>
  queryMysql(conn, "SELECT 1", []).pipe(
    Effect.as(true),
    Effect.catchAll(() => Effect.succeed(false)),
  )

const toQueryResult = (rows: ReadonlyArray<Record<string, unknown>>): QueryResult => {
  const columns: ReadonlyArray<ColumnInfo> =
    rows.length > 0 ? Object.keys(rows[0]!).map((name) => ({ name })) : []
  return { columns, rows }
}

export class MysqlDriver extends Context.Tag("MysqlDriver")<
  MysqlDriver,
  DriverService<MysqlConnectionConfig>
>() {}

export namespace MysqlDriver {
  /** `MysqlDriver` service backed by @effect/sql-mysql2. */
  export const layer: Layer.Layer<MysqlDriver> = Layer.succeed(MysqlDriver, {
    connect: connectMysql,
    query: queryMysql,
    disconnect: disconnectMysql,
    isConnected: isConnectedMysql,
  })
}