import { Context, Effect, Layer } from "effect"
import { DatabaseDriver } from "@/drivers/database-driver"
import type { DriverService } from "@/drivers/types"
import { mysqlQueries } from "@/inspector/mysql"
import { pgQueries } from "@/inspector/pg"
import { sqliteQueries } from "@/inspector/sqlite"
import type { SchemaInspectorService } from "@/inspector/types"

export class SchemaInspector extends Context.Tag("SchemaInspector")<SchemaInspector, SchemaInspectorService>() {}

/**
 * `SchemaInspector` facade. Like `DatabaseDriver`, it presents the
 * engine-neutral service contract and dispatches to the per-engine query
 * modules based on `conn.engine`.
 *
 * The layer depends on `DatabaseDriver` — inspector queries run through the
 * same service the rest of the app uses, so there is exactly one way to talk
 * to a database.
 */
export namespace SchemaInspector {
  export const layer: Layer.Layer<SchemaInspector, never, DatabaseDriver> = Layer.effect(
    SchemaInspector,
    Effect.gen(function* () {
      const driver: DriverService = yield* DatabaseDriver
      const pg = pgQueries(driver)
      const mysql = mysqlQueries(driver)
      const sqlite = sqliteQueries(driver)
      return {
        listTables: conn =>
          conn.engine === "postgres"
            ? pg.listTables(conn)
            : conn.engine === "mysql"
              ? mysql.listTables(conn)
              : sqlite.listTables(conn),
        describeTable: (conn, tableName) =>
          conn.engine === "postgres"
            ? pg.describeTable(conn, tableName)
            : conn.engine === "mysql"
              ? mysql.describeTable(conn, tableName)
              : sqlite.describeTable(conn, tableName),
        getPrimaryKey: (conn, tableName) =>
          conn.engine === "postgres"
            ? pg.getPrimaryKey(conn, tableName)
            : conn.engine === "mysql"
              ? mysql.getPrimaryKey(conn, tableName)
              : sqlite.getPrimaryKey(conn, tableName),
      }
    })
  )
}
