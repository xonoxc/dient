import { Effect, Option } from "effect"
import type { ActiveConnection, DriverService, QueryError } from "@/drivers/types"
import type { TableColumn, TableForeignKey, TableIndex, TableInfo, TableQueries } from "@/inspector/types"

/**
 * PostgreSQL introspection via `information_schema` (tables, columns) and
 * `pg_catalog` (primary keys, indexes, foreign keys).
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
      `SELECT a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS data_type,
            NOT a.attnotnull AS is_nullable,
            pg_get_expr(d.adbin, d.adrelid) AS column_default
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE c.relname = $1
       AND c.relkind IN ('r', 'p')
       AND c.relnamespace NOT IN (
         SELECT oid FROM pg_namespace WHERE nspname IN ('pg_catalog', 'information_schema')
       )
       AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY a.attnum`,
      [tableName]
    )
    .pipe(
      Effect.map(result =>
        result.rows.map(
          row =>
            ({
              name: String(row.column_name),
              type: String(row.data_type),
              nullable: row.is_nullable === true,
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

interface IndexRow {
  readonly index_name: string
  readonly column_name: string
  readonly is_unique: boolean
  readonly is_primary: boolean
}

export const indexesPg = (
  driver: DriverService,
  conn: ActiveConnection,
  tableName: string
): Effect.Effect<ReadonlyArray<TableIndex>, QueryError> =>
  driver
    .query(
      conn,
      `SELECT i.relname AS index_name,
            a.attname AS column_name,
            ix.indisunique AS is_unique,
            ix.indisprimary AS is_primary
     FROM pg_index ix
     JOIN pg_class t ON t.oid = ix.indrelid
     JOIN pg_class i ON i.oid = ix.indexrelid
     JOIN unnest(ix.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ord) ON true
     JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
     WHERE t.relname = $1
     ORDER BY i.relname, k.ord`,
      [tableName]
    )
    .pipe(Effect.map(result => groupIndexes(result.rows as unknown as ReadonlyArray<IndexRow>)))

interface ForeignKeyRow {
  readonly constraint_name: string
  readonly column_name: string
  readonly referenced_table: string
  readonly referenced_column: string
}

export const foreignKeysPg = (
  driver: DriverService,
  conn: ActiveConnection,
  tableName: string
): Effect.Effect<ReadonlyArray<TableForeignKey>, QueryError> =>
  driver
    .query(
      conn,
      `SELECT c.conname AS constraint_name,
            a.attname AS column_name,
            rt.relname AS referenced_table,
            ra.attname AS referenced_column
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_class rt ON rt.oid = c.confrelid
     JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
     JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
     JOIN unnest(c.confkey) WITH ORDINALITY AS rk(attnum, ord) ON rk.ord = k.ord
     JOIN pg_attribute ra ON ra.attrelid = rt.oid AND ra.attnum = rk.attnum
     WHERE c.contype = 'f'
       AND t.relname = $1
     ORDER BY c.conname, k.ord`,
      [tableName]
    )
    .pipe(Effect.map(result => groupForeignKeys(result.rows as unknown as ReadonlyArray<ForeignKeyRow>)))

const quoteIdentifier = (name: string): string => `"${name.replace(/"/g, '""')}"`

/**
 * PostgreSQL has no built-in `SHOW CREATE TABLE` (the common helper is an
 * extension), so describeTable emits a faithful CREATE statement from the
 * catalog rows it already fetched. Indexes and foreign keys remain listed
 * separately in the schema viewer.
 */
export const generatedDdlPg = (info: Omit<TableInfo, "ddl">): string => {
  const lines = info.columns.map(column => {
    const parts = [quoteIdentifier(column.name), column.type]
    if (!column.nullable) parts.push("NOT NULL")
    if (column.default !== undefined) parts.push(`DEFAULT ${String(column.default)}`)
    return `  ${parts.join(" ")}`
  })
  if (info.primaryKey.length > 0) {
    lines.push(`  PRIMARY KEY (${info.primaryKey.map(quoteIdentifier).join(", ")})`)
  }
  for (const fk of info.foreignKeys) {
    lines.push(
      `  CONSTRAINT ${quoteIdentifier(fk.name)} FOREIGN KEY (${fk.columns
        .map(quoteIdentifier)
        .join(", ")}) REFERENCES ${quoteIdentifier(fk.referencedTable)} (${fk.referencedColumns
        .map(quoteIdentifier)
        .join(", ")})`
    )
  }
  return `CREATE TABLE ${quoteIdentifier(info.name)} (\n${lines.join(",\n")}\n);`
}

export const describeTablePg = (
  driver: DriverService,
  conn: ActiveConnection,
  tableName: string
): Effect.Effect<Option.Option<TableInfo>, QueryError> =>
  Effect.gen(function* () {
    const [columns, primaryKey, indexes, foreignKeys] = yield* Effect.all(
      [
        columnsPg(driver, conn, tableName),
        getPrimaryKeyPg(driver, conn, tableName),
        indexesPg(driver, conn, tableName),
        foreignKeysPg(driver, conn, tableName),
      ],
      { concurrency: 4 }
    )
    if (columns.length === 0) {
      return Option.none<TableInfo>()
    }
    const base = { name: tableName, columns, primaryKey, indexes, foreignKeys }
    return Option.some<TableInfo>({ ...base, ddl: generatedDdlPg(base) })
  })

export const groupIndexes = (rows: ReadonlyArray<IndexRow>): ReadonlyArray<TableIndex> => {
  const byName = new Map<string, { columns: string[]; unique: boolean; primary: boolean }>()
  for (const row of rows) {
    const name = String(row.index_name)
    const entry = byName.get(name) ?? { columns: [], unique: false, primary: false }
    entry.columns.push(String(row.column_name))
    entry.unique = entry.unique || row.is_unique === true
    entry.primary = entry.primary || row.is_primary === true
    byName.set(name, entry)
  }
  return Array.from(byName, ([name, entry]) => ({ name, ...entry }))
}

export const groupForeignKeys = (rows: ReadonlyArray<ForeignKeyRow>): ReadonlyArray<TableForeignKey> => {
  const byName = new Map<string, { columns: string[]; referencedTable: string; referencedColumns: string[] }>()
  for (const row of rows) {
    const name = String(row.constraint_name)
    const entry = byName.get(name) ?? {
      columns: [],
      referencedTable: String(row.referenced_table),
      referencedColumns: [],
    }
    entry.columns.push(String(row.column_name))
    entry.referencedColumns.push(String(row.referenced_column))
    byName.set(name, entry)
  }
  return Array.from(byName, ([name, entry]) => ({ name, ...entry }))
}

export const pgQueries = (driver: DriverService): TableQueries => ({
  listTables: conn => listTablesPg(driver, conn),
  describeTable: (conn, tableName) => describeTablePg(driver, conn, tableName),
  getPrimaryKey: (conn, tableName) => getPrimaryKeyPg(driver, conn, tableName),
})
