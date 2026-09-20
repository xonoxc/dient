import { Effect, Option } from "effect"
import type { ActiveConnection, DriverService, QueryError } from "@/drivers/types"
import type { TableColumn, TableInfo, TableQueries } from "@/inspector/types"

/**
 * MySQL introspection via `information_schema`. Everything is scoped to the
 * connection's current database (`DATABASE()`), so results always describe the
 * schema the connection is actually using. Placeholders are `?` (native to
 * mysql2).
 */

export const listTablesMysql = (
  driver: DriverService,
  conn: ActiveConnection
): Effect.Effect<ReadonlyArray<string>, QueryError> =>
  driver
    .query(
      conn,
      `SELECT table_name AS table_name
     FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND table_type = 'BASE TABLE'
     ORDER BY table_name`
    )
    .pipe(Effect.map(result => result.rows.map(row => String(row.table_name))))

export const columnsMysql = (
  driver: DriverService,
  conn: ActiveConnection,
  tableName: string
): Effect.Effect<ReadonlyArray<TableColumn>, QueryError> =>
  driver
    .query(
      conn,
      `SELECT column_name AS column_name,
            data_type AS data_type,
            is_nullable AS is_nullable,
            column_default AS column_default
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = ?
     ORDER BY ordinal_position`,
      [tableName]
    )
    .pipe(
      Effect.map(result =>
        result.rows.map(
          row =>
            ({
              name: String(row.column_name),
              type: String(row.data_type),
              nullable: row.is_nullable === "YES",
              default: row.column_default ?? undefined,
            }) as TableColumn
        )
      )
    )

export const getPrimaryKeyMysql = (
  driver: DriverService,
  conn: ActiveConnection,
  tableName: string
): Effect.Effect<ReadonlyArray<string>, QueryError> =>
  driver
    .query(
      conn,
      `SELECT column_name AS column_name
     FROM information_schema.key_column_usage
     WHERE table_schema = DATABASE()
       AND table_name = ?
       AND constraint_name = 'PRIMARY'
     ORDER BY ordinal_position`,
      [tableName]
    )
    .pipe(Effect.map(result => result.rows.map(row => String(row.column_name))))

export const describeTableMysql = (
  driver: DriverService,
  conn: ActiveConnection,
  tableName: string
): Effect.Effect<Option.Option<TableInfo>, QueryError> =>
  columnsMysql(driver, conn, tableName).pipe(
    Effect.flatMap(columns => {
      if (columns.length === 0) {
        return Effect.succeed(Option.none<TableInfo>())
      }
      return getPrimaryKeyMysql(driver, conn, tableName).pipe(
        Effect.map(primaryKey => Option.some<TableInfo>({ name: tableName, columns, primaryKey }))
      )
    })
  )

export const mysqlQueries = (driver: DriverService): TableQueries => ({
  listTables: conn => listTablesMysql(driver, conn),
  describeTable: (conn, tableName) => describeTableMysql(driver, conn, tableName),
  getPrimaryKey: (conn, tableName) => getPrimaryKeyMysql(driver, conn, tableName),
})
