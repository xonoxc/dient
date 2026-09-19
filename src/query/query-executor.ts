/**
 * QueryExecutor is the engine-agnostic way to run SQL once a connection is
 * open. It builds trivial, safe statements (paged `SELECT *` and `COUNT(*)`)
 * and defers the actual execution to ConnectionManager, so screens never build
 * SQL or touch raw clients.
 */
import { ConnectionManager } from "@/connection/connection-manager"
import type { ConnectionId } from "@/domain"
import type { ActiveConnection, QueryResult } from "@/drivers/types"
import { QueryError } from "@/drivers/types"
import { cleanIdentifier, limitClause, isSafeName } from "@/query/identifier"
import { Context, Effect, Layer } from "effect"

export interface TablePage {
  readonly limit: number
  readonly offset: number
}

export type QueryFailure = import("@/drivers/types").QueryError | import("@/drivers/types").ConnectionError | import("@/config").ConfigError

export interface QueryExecutorService {
  readonly execute: (
    connectionId: ConnectionId,
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Effect.Effect<QueryResult, QueryFailure>
  readonly loadTable: (
    connectionId: ConnectionId,
    database: import("@/domain").Database,
    table: string,
    page: TablePage
  ) => Effect.Effect<QueryResult, QueryFailure>
  readonly count: (connectionId: ConnectionId, database: import("@/domain").Database, table: string) => Effect.Effect<number, QueryFailure>
}

export class QueryExecutor extends Context.Tag("QueryExecutor")<QueryExecutor, QueryExecutorService>() {}

export namespace QueryExecutor {
  export const layer: Layer.Layer<QueryExecutor, never, ConnectionManager> = Layer.effect(
    QueryExecutor,
    Effect.gen(function* () {
      const manager = yield* ConnectionManager
      return {
        execute: (connectionId, sql, params) =>
          manager.query(connectionId, sql, params).pipe(Effect.mapError(e => e as QueryFailure)),
        loadTable: (connectionId, database, table, page) =>
          Effect.gen(function* () {
            if (!isSafeName(table)) return yield* Effect.fail(new QueryError({ engine: database.engine, message: `unsafe table name: ${table}` }))
            const name = cleanIdentifier(database.engine, table)
            return yield* manager.query(connectionId, `SELECT * FROM ${name} ${limitClause(page.limit, page.offset)}`)
          }),
        count: (connectionId, database, table) =>
          Effect.gen(function* () {
            if (!isSafeName(table)) return yield* Effect.fail(new QueryError({ engine: database.engine, message: `unsafe table name: ${table}` }))
            const name = cleanIdentifier(database.engine, table)
            const result = yield* manager.query(connectionId, `SELECT COUNT(*) AS total FROM ${name}`)
            const total = result.rows[0]?.["total"]
            const parsed = typeof total === "number" ? total : Number.parseInt(String(total ?? ""), 10)
            if (Number.isNaN(parsed)) return yield* Effect.fail(new QueryError({ engine: database.engine, message: `COUNT(*) returned an unexpected shape` }))
            return parsed
          }),
      }
    })
  )
}

export type { ActiveConnection }