import { Effect, Option } from "effect"
import type { ActiveConnection, DriverService, QueryError } from "@/drivers/types"
import type { TableColumn, TableInfo, TableQueries } from "@/inspector/types"

/**
 * SQLite introspection via `sqlite_master` (table names) and
 * `PRAGMA table_info` (columns + primary key order).
 *
 * `PRAGMA table_info` does not accept bound parameters, so the table name is
 * inlined as a quoted identifier; user-supplied names are validated against the
 * identifier grammar first, and any embedded quotes are doubled so the pragma
 * can never be smuggled extra statements.
 */

const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_$]*$/

const quoteIdentifier = (name: string): string | undefined => {
  if (!IDENTIFIER.test(name)) {
    return undefined
  }
  return `"${name.replace(/"/g, '""')}"`
}

export const listTablesSqlite = (
  driver: DriverService,
  conn: ActiveConnection
): Effect.Effect<ReadonlyArray<string>, QueryError> =>
  driver
    .query(
      conn,
      `SELECT name
     FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
     ORDER BY name`
    )
    .pipe(Effect.map(result => result.rows.map(row => String(row.name))))

export const pragmaColumns = (
  driver: DriverService,
  conn: ActiveConnection,
  tableName: string
): Effect.Effect<ReadonlyArray<TableColumn>, QueryError> => {
  const quoted = quoteIdentifier(tableName)
  if (quoted === undefined) {
    return Effect.succeed([])
  }
  return driver.query(conn, `PRAGMA table_info(${quoted})`).pipe(
    Effect.map(result =>
      result.rows.map(
        row =>
          ({
            name: String(row.name),
            type: String(row.type),
            nullable: row.notnull !== 1,
            default: row.dflt_value ?? undefined,
          }) as TableColumn
      )
    )
  )
}

export const getPrimaryKeySqlite = (
  driver: DriverService,
  conn: ActiveConnection,
  tableName: string
): Effect.Effect<ReadonlyArray<string>, QueryError> => {
  const quoted = quoteIdentifier(tableName)
  if (quoted === undefined) {
    return Effect.succeed([])
  }
  return driver.query(conn, `PRAGMA table_info(${quoted})`).pipe(
    Effect.map(result =>
      result.rows
        .filter(row => Number(row.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map(row => String(row.name))
    )
  )
}

export const describeTableSqlite = (
  driver: DriverService,
  conn: ActiveConnection,
  tableName: string
): Effect.Effect<Option.Option<TableInfo>, QueryError> =>
  pragmaColumns(driver, conn, tableName).pipe(
    Effect.flatMap(columns => {
      if (columns.length === 0) {
        return Effect.succeed(Option.none<TableInfo>())
      }
      return getPrimaryKeySqlite(driver, conn, tableName).pipe(
        Effect.map(primaryKey => Option.some<TableInfo>({ name: tableName, columns, primaryKey }))
      )
    })
  )

export const sqliteQueries = (driver: DriverService): TableQueries => ({
  listTables: conn => listTablesSqlite(driver, conn),
  describeTable: (conn, tableName) => describeTableSqlite(driver, conn, tableName),
  getPrimaryKey: (conn, tableName) => getPrimaryKeySqlite(driver, conn, tableName),
})
