import { Effect, Option } from "effect"
import type { ActiveConnection, DriverService, QueryError } from "@/drivers/types"
import type { TableColumn, TableForeignKey, TableIndex, TableInfo, TableQueries } from "@/inspector/types"

/**
 * SQLite introspection via `sqlite_master` (table names + DDL),
 * `PRAGMA table_info` (columns + primary key order), `PRAGMA index_list` /
 * `PRAGMA index_info` (indexes), and `PRAGMA foreign_key_list` (foreign keys).
 *
 * PRAGMA statements do not accept bound parameters, so table and index names
 * are inlined as quoted identifiers; user-supplied names are validated against
 * the identifier grammar first, and embedded quotes are doubled so the pragma
 * can never be smuggled extra statements. DDL lookup uses a normal SELECT with
 * a bound parameter.
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

export const indexesSqlite = (
  driver: DriverService,
  conn: ActiveConnection,
  tableName: string
): Effect.Effect<ReadonlyArray<TableIndex>, QueryError> => {
  const quoted = quoteIdentifier(tableName)
  if (quoted === undefined) {
    return Effect.succeed([])
  }
  return Effect.gen(function* () {
    const listed = yield* driver.query(conn, `PRAGMA index_list(${quoted})`)
    const indexes: Array<TableIndex> = []
    for (const row of listed.rows) {
      const indexName = String(row.name)
      const quotedIndex = quoteIdentifier(indexName)
      if (quotedIndex === undefined) continue
      const details = yield* driver.query(conn, `PRAGMA index_info(${quotedIndex})`)
      const columns = details.rows
        .slice()
        .sort((a, b) => Number(a.seqno) - Number(b.seqno))
        .map(detail => String(detail.name ?? ""))
        .filter(name => name.length > 0)
      indexes.push({
        name: indexName,
        columns,
        unique: Number(row.unique) === 1,
        primary: String(row.origin) === "pk",
      })
    }
    return indexes
  })
}

export const foreignKeysSqlite = (
  driver: DriverService,
  conn: ActiveConnection,
  tableName: string
): Effect.Effect<ReadonlyArray<TableForeignKey>, QueryError> => {
  const quoted = quoteIdentifier(tableName)
  if (quoted === undefined) {
    return Effect.succeed([])
  }
  return driver.query(conn, `PRAGMA foreign_key_list(${quoted})`).pipe(
    Effect.map(result => {
      /* SQLite does not expose constraint names through the pragma; group by
         the synthetic id and use a stable "fk_<id>" label in the viewer. */
      const byId = new Map<number, { columns: string[]; referencedTable: string; referencedColumns: string[] }>()
      for (const row of result.rows) {
        const id = Number(row.id)
        const entry = byId.get(id) ?? {
          columns: [],
          referencedTable: String(row.table),
          referencedColumns: [],
        }
        entry.columns.push(String(row.from))
        entry.referencedColumns.push(String(row.to))
        byId.set(id, entry)
      }
      return Array.from(byId, ([id, entry]) => ({ name: `fk_${id}`, ...entry }))
    })
  )
}

export const ddlSqlite = (
  driver: DriverService,
  conn: ActiveConnection,
  tableName: string
): Effect.Effect<string | undefined, QueryError> =>
  driver.query(conn, `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, [tableName]).pipe(
    Effect.map(result => {
      const value = result.rows[0]?.sql
      return value === undefined || value === null ? undefined : String(value)
    })
  )

export const describeTableSqlite = (
  driver: DriverService,
  conn: ActiveConnection,
  tableName: string
): Effect.Effect<Option.Option<TableInfo>, QueryError> =>
  Effect.gen(function* () {
    const [columns, primaryKey, indexes, foreignKeys, ddl] = yield* Effect.all(
      [
        pragmaColumns(driver, conn, tableName),
        getPrimaryKeySqlite(driver, conn, tableName),
        indexesSqlite(driver, conn, tableName),
        foreignKeysSqlite(driver, conn, tableName),
        ddlSqlite(driver, conn, tableName),
      ],
      { concurrency: 5 }
    )
    if (columns.length === 0) {
      return Option.none<TableInfo>()
    }
    return Option.some<TableInfo>({ name: tableName, columns, primaryKey, indexes, foreignKeys, ddl })
  })

export const sqliteQueries = (driver: DriverService): TableQueries => ({
  listTables: conn => listTablesSqlite(driver, conn),
  describeTable: (conn, tableName) => describeTableSqlite(driver, conn, tableName),
  getPrimaryKey: (conn, tableName) => getPrimaryKeySqlite(driver, conn, tableName),
})
