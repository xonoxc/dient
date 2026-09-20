import { Effect, Option } from "effect"
import type { ActiveConnection, QueryError } from "@/drivers/types"

/**
 * Schema introspection model. These types describe a real table as reported by
 * the engine, unlike the driver's `ColumnInfo` which is only name metadata
 * derived from a result set.
 */
export interface TableColumn {
  readonly name: string
  readonly type: string
  readonly nullable: boolean
  readonly default?: unknown
}

export interface TableInfo {
  readonly name: string
  readonly columns: ReadonlyArray<TableColumn>
  readonly primaryKey: ReadonlyArray<string>
}

/**
 * The SchemaInspector service. Every method runs over a live `ActiveConnection`
 * handed in by the caller (the same handle the drivers return) and dispatches
 * to the engine's introspection tables.
 *
 * - `listTables` returns every user table for the connection's database.
 * - `describeTable` returns the full column + primary key shape of one table,
 *   or `Option.none()` when the table does not exist.
 * - `getPrimaryKey` returns the ordered primary key columns, or `[]` when the
 *   table is absent or has no primary key.
 *
 * Only `QueryError` (the underlying query failing) is a real failure; a missing
 * table is a normal outcome, never an error.
 */
export interface SchemaInspectorService {
  readonly listTables: (conn: ActiveConnection) => Effect.Effect<ReadonlyArray<string>, QueryError>
  readonly describeTable: (
    conn: ActiveConnection,
    tableName: string
  ) => Effect.Effect<Option.Option<TableInfo>, QueryError>
  readonly getPrimaryKey: (
    conn: ActiveConnection,
    tableName: string
  ) => Effect.Effect<ReadonlyArray<string>, QueryError>
}

/** Internal unit the per-engine modules implement. */
export interface TableQueries {
  readonly listTables: (conn: ActiveConnection) => Effect.Effect<ReadonlyArray<string>, QueryError>
  readonly describeTable: (
    conn: ActiveConnection,
    tableName: string
  ) => Effect.Effect<Option.Option<TableInfo>, QueryError>
  readonly getPrimaryKey: (
    conn: ActiveConnection,
    tableName: string
  ) => Effect.Effect<ReadonlyArray<string>, QueryError>
}
