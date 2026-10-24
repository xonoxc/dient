import { Context, Effect, Layer } from "effect"
import type { SqlConnectionConfig } from "@/domain"
import { MysqlDriver } from "@/drivers/mysql"
import { PgDriver } from "@/drivers/pg"
import { SqliteDriver } from "@/drivers/sqlite"
import { QueryError, type ActiveConnection, type DriverService } from "@/drivers/types"

/**
 * `DatabaseDriver` is the single service callers talk to for SQL engines. It
 * presents the engine-neutral `DriverService` contract and dispatches each call
 * to the matching per-engine driver based on `config.engine` (for `connect`) or
 * `conn.engine` (for everything else). Redis has its own driver and is rejected
 * here rather than accidentally falling through to SQLite.
 */
export class DatabaseDriver extends Context.Tag("DatabaseDriver")<
  DatabaseDriver,
  DriverService<SqlConnectionConfig>
>() {}

export namespace DatabaseDriver {
  /**
   * The live facade: reads the three engine drivers from the environment and
   * forwards calls. Building the dispatch table at construction keeps every
   * call a plain function invocation — no per-query tag lookups.
   *
   * The required `Scope` for `connect` is deliberately left in the signature:
   * whoever performs a connect is responsible for providing a scope that will
   * outlive the connection, since `disconnect` tears the pool down through
   * that same scope.
   */
  export const layer: Layer.Layer<DatabaseDriver, never, never> = Layer.effect(
    DatabaseDriver,
    Effect.gen(function* () {
      const pg = yield* PgDriver
      const mysql = yield* MysqlDriver
      const sqlite = yield* SqliteDriver

      return {
        connect: (config: SqlConnectionConfig) =>
          config.engine === "postgres"
            ? pg.connect(config)
            : config.engine === "mysql"
              ? mysql.connect(config)
              : sqlite.connect(config),
        query: (conn: ActiveConnection, sql: string, params?: ReadonlyArray<unknown>) => {
          if (conn.engine === "redis") {
            return Effect.fail(
              new QueryError({ engine: "redis", message: "SQL queries are not supported on a Redis connection" })
            )
          }
          return conn.engine === "postgres"
            ? pg.query(conn, sql, params)
            : conn.engine === "mysql"
              ? mysql.query(conn, sql, params)
              : sqlite.query(conn, sql, params)
        },
        disconnect: (conn: ActiveConnection) => {
          if (conn.engine === "redis") return Effect.void
          return conn.engine === "postgres"
            ? pg.disconnect(conn)
            : conn.engine === "mysql"
              ? mysql.disconnect(conn)
              : sqlite.disconnect(conn)
        },
        isConnected: (conn: ActiveConnection) => {
          if (conn.engine === "redis") return Effect.succeed(false)
          return conn.engine === "postgres"
            ? pg.isConnected(conn)
            : conn.engine === "mysql"
              ? mysql.isConnected(conn)
              : sqlite.isConnected(conn)
        },
      }
    })
  ).pipe(Layer.provide(Layer.mergeAll(PgDriver.layer, MysqlDriver.layer, SqliteDriver.layer)))
}
