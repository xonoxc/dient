import { Effect, Option } from "effect"
import type { ActiveConnection, DriverService, QueryError } from "@/drivers/types"
import type { TableColumn, TableForeignKey, TableIndex, TableInfo, TableQueries } from "@/inspector/types"

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

interface IndexRow {
  readonly index_name: string
  readonly column_name: string
  readonly non_unique: number
}

export const indexesMysql = (
  driver: DriverService,
  conn: ActiveConnection,
  tableName: string
): Effect.Effect<ReadonlyArray<TableIndex>, QueryError> =>
  driver
    .query(
      conn,
      `SELECT index_name AS index_name,
            column_name AS column_name,
            non_unique AS non_unique
     FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = ?
     ORDER BY index_name, seq_in_index`,
      [tableName]
    )
    .pipe(
      Effect.map(result => {
        const byName = new Map<string, { columns: string[]; unique: boolean; primary: boolean }>()
        for (const row of result.rows as unknown as ReadonlyArray<IndexRow>) {
          const name = String(row.index_name)
          const entry = byName.get(name) ?? { columns: [], unique: true, primary: name === "PRIMARY" }
          entry.columns.push(String(row.column_name))
          entry.unique = entry.unique && Number(row.non_unique) === 0
          byName.set(name, entry)
        }
        return Array.from(byName, ([name, entry]) => ({ name, ...entry }))
      })
    )

interface ForeignKeyRow {
  readonly constraint_name: string
  readonly column_name: string
  readonly referenced_table_name: string
  readonly referenced_column_name: string
}

export const foreignKeysMysql = (
  driver: DriverService,
  conn: ActiveConnection,
  tableName: string
): Effect.Effect<ReadonlyArray<TableForeignKey>, QueryError> =>
  driver
    .query(
      conn,
      `SELECT constraint_name AS constraint_name,
            column_name AS column_name,
            referenced_table_name AS referenced_table_name,
            referenced_column_name AS referenced_column_name
     FROM information_schema.key_column_usage
     WHERE table_schema = DATABASE()
       AND table_name = ?
       AND referenced_table_name IS NOT NULL
     ORDER BY constraint_name, ordinal_position`,
      [tableName]
    )
    .pipe(
      Effect.map(result => {
        const byName = new Map<string, { columns: string[]; referencedTable: string; referencedColumns: string[] }>()
        for (const row of result.rows as unknown as ReadonlyArray<ForeignKeyRow>) {
          const name = String(row.constraint_name)
          const entry = byName.get(name) ?? {
            columns: [],
            referencedTable: String(row.referenced_table_name),
            referencedColumns: [],
          }
          entry.columns.push(String(row.column_name))
          entry.referencedColumns.push(String(row.referenced_column_name))
          byName.set(name, entry)
        }
        return Array.from(byName, ([name, entry]) => ({ name, ...entry }))
      })
    )

const quoteMysqlIdentifier = (name: string): string => `\`${name.replace(/`/g, "``")}\``

export const ddlMysql = (
  driver: DriverService,
  conn: ActiveConnection,
  tableName: string
): Effect.Effect<string | undefined, QueryError> =>
  driver.query(conn, `SHOW CREATE TABLE ${quoteMysqlIdentifier(tableName)}`).pipe(
    Effect.map(result => {
      const row = result.rows[0]
      if (!row) return undefined
      /* mysql2 reports the DDL column as "Create Table"; some versions use a
         lower-case alias, so accept either rather than betting on one. */
      const value =
        row["Create Table"] ??
        row["CREATE TABLE"] ??
        Object.values(row).find(
          candidate => typeof candidate === "string" && candidate.toUpperCase().includes("CREATE TABLE")
        )
      return value === undefined || value === null ? undefined : String(value)
    }),
    Effect.orElseSucceed(() => undefined)
  )

export const describeTableMysql = (
  driver: DriverService,
  conn: ActiveConnection,
  tableName: string
): Effect.Effect<Option.Option<TableInfo>, QueryError> =>
  Effect.gen(function* () {
    const [columns, primaryKey, indexes, foreignKeys, ddl] = yield* Effect.all(
      [
        columnsMysql(driver, conn, tableName),
        getPrimaryKeyMysql(driver, conn, tableName),
        indexesMysql(driver, conn, tableName),
        foreignKeysMysql(driver, conn, tableName),
        ddlMysql(driver, conn, tableName),
      ],
      { concurrency: 5 }
    )
    if (columns.length === 0) {
      return Option.none<TableInfo>()
    }
    return Option.some<TableInfo>({ name: tableName, columns, primaryKey, indexes, foreignKeys, ddl })
  })

export const mysqlQueries = (driver: DriverService): TableQueries => ({
  listTables: conn => listTablesMysql(driver, conn),
  describeTable: (conn, tableName) => describeTableMysql(driver, conn, tableName),
  getPrimaryKey: (conn, tableName) => getPrimaryKeyMysql(driver, conn, tableName),
})
