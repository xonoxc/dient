import { Schema as S } from "effect"

/**
 * Core domain model for dient: projects, databases, and connections, plus the
 * engine-specific settings a driver needs to actually open a connection.
 *
 * Everything is declared as an Effect Schema rather than a plain interface,
 * which gives us two things for free:
 *
 *   1. The `Project`/`Database`/... types are inferred directly from the
 *      schemas, so the type definition can never drift from the runtime
 *      decoder.
 *   2. The same schemas validate data at the edge — decodes of DB rows or
 *      user input fail loudly instead of silently accepting malformed data.
 *
 * Hierarchy (each level cascades to the next on delete):
 *
 *   Project → Database (scoped to a project) → Connection (scoped to a database)
 */

/**
 * Branded string types. `ProjectId`, `DatabaseId` and `ConnectionId` are all
 * plain strings at runtime, but branding makes it a compile-time error to hand
 * one kind of ID to a function expecting another. The underlying schemas still
 * reject non-strings at decode time.
 */
export const ProjectId = S.String.pipe(S.brand("ProjectId"))
export type ProjectId = S.Schema.Type<typeof ProjectId>

export const DatabaseId = S.String.pipe(S.brand("DatabaseId"))
export type DatabaseId = S.Schema.Type<typeof DatabaseId>

export const ConnectionId = S.String.pipe(S.brand("ConnectionId"))
export type ConnectionId = S.Schema.Type<typeof ConnectionId>

/**
 * The database engines dient can talk to. Kept as a `Literal` union so an
 * unsupported engine value fails validation at runtime instead of silently
 * reaching a driver that doesn't know it.
 */
export const Engine = S.Literal("postgres", "mysql", "sqlite")
export type Engine = S.Schema.Type<typeof Engine>

export const ProjectSchema = S.Struct({
  id: ProjectId,
  name: S.String,
})
export type Project = S.Schema.Type<typeof ProjectSchema>

export const DatabaseSchema = S.Struct({
  id: DatabaseId,
  projectId: ProjectId,
  name: S.String,
  engine: Engine,
})
export type Database = S.Schema.Type<typeof DatabaseSchema>

export const ConnectionSchema = S.Struct({
  id: ConnectionId,
  databaseId: DatabaseId,
  host: S.optional(S.String),
  port: S.optional(S.Number),
  user: S.optional(S.String),
  password: S.optional(S.String),
  filename: S.optional(S.String),
  defaultDatabase: S.optional(S.String),
})
export type Connection = S.Schema.Type<typeof ConnectionSchema>

/**
 * `ConnectionConfig` is the shape handed to a driver when actually connecting.
 * It is the union of every engine's options, discriminated by the `engine`
 * field, so a config for one engine can never accidentally carry fields meant
 * for another. `ConnectionSchema` stores the raw settings in a single table;
 * drivers resolve a `Connection` to its engine's `ConnectionConfig` later.
 */
export const PostgresConnectionConfig = S.Struct({
  engine: S.Literal("postgres"),
  host: S.optional(S.String),
  port: S.optional(S.Number),
  user: S.optional(S.String),
  password: S.optional(S.String),
  defaultDatabase: S.optional(S.String),
})
export type PostgresConnectionConfig = S.Schema.Type<typeof PostgresConnectionConfig>

export const MysqlConnectionConfig = S.Struct({
  engine: S.Literal("mysql"),
  host: S.optional(S.String),
  port: S.optional(S.Number),
  user: S.optional(S.String),
  password: S.optional(S.String),
  defaultDatabase: S.optional(S.String),
})
export type MysqlConnectionConfig = S.Schema.Type<typeof MysqlConnectionConfig>

/**
 * SQLite is file-based, so the only required option is where the file lives;
 * there is no host, user, or password to configure.
 */
export const SqliteConnectionConfig = S.Struct({
  engine: S.Literal("sqlite"),
  filename: S.String,
})
export type SqliteConnectionConfig = S.Schema.Type<typeof SqliteConnectionConfig>

export const ConnectionConfig = S.Union(
  PostgresConnectionConfig,
  MysqlConnectionConfig,
  SqliteConnectionConfig,
)
export type ConnectionConfig = S.Schema.Type<typeof ConnectionConfig>
