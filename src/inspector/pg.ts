import { Effect, Option } from "effect"
import type { ActiveConnection, DriverService, QueryError } from "@/drivers/types"
import type { TableColumn, TableInfo, TableQueries } from "@/inspector/types"

/**
 * PostgreSQL introspection via `information_schema` (tables, columns) and
 * `pg_catalog` (primary key ordering).
 *
 * System schemas (`pg_catalog`, `information_schema`) are always excluded so
 * `listTables` only ever returns user tables. Placeholders are `$n` because
 * `@effect/sql-pg` hands the raw SQL to `pg`, which uses `$1`-style binds.
 */

export const listTablesPg = (
  driver: DriverService,
  conn: ActiveConnection
): Effect.Effect<ReadonlyArray<string>, QueryError> =>
  driver
    .query(
      conn,
      `SELECT table_name
     FROM information_schema.tables
     WHERE table_type = 'BASE TABLE'
       AND table_schema NOT IN ('pg_catalog', 'information_schema')
     ORDER BY table_name`
    )
    .pipe(Effect.map(result => result.rows.map(row => String(row.table_name))))

export const columnsPg = (
  driver: DriverService,
  conn: ActiveConnection,
  tableName: string
): Effect.Effect<ReadonlyArray<TableColumn>, QueryError> =>
  driver
    .query(
      conn,
      `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       AND table_name = $1
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

export const getPrimaryKeyPg = (
  driver: DriverService,
  conn: ActiveConnection,
  tableName: string
): Effect.Effect<ReadonlyArray<string>, QueryError> =>
  driver
    .query(
      conn,
      `SELECT a.attname
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indrelid
     JOIN unnest(i.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ord) ON true
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
     WHERE i.indisprimary
       AND c.relname = $1
     ORDER BY k.ord`,
      [tableName]
    )
    .pipe(Effect.map(result => result.rows.map(row => String(row.attname))))

export const describeTablePg = (
  driver: DriverService,
  conn: ActiveConnection,
  tableName: string
): Effect.Effect<Option.Option<TableInfo>, QueryError> =>
  columnsPg(driver, conn, tableName).pipe(
    Effect.flatMap(columns => {
      if (columns.length === 0) {
        return Effect.succeed(Option.none<TableInfo>())
      }
      return getPrimaryKeyPg(driver, conn, tableName).pipe(
        Effect.map(primaryKey => Option.some<TableInfo>({ name: tableName, columns, primaryKey }))
      )
    })
  )

export const pgQueries = (driver: DriverService): TableQueries => ({
  listTables: conn => listTablesPg(driver, conn),
  describeTable: (conn, tableName) => describeTablePg(driver, conn, tableName),
  getPrimaryKey: (conn, tableName) => getPrimaryKeyPg(driver, conn, tableName),
})
