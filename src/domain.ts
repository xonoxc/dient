import { Schema as S } from "effect"

export const ProjectId = S.String.pipe(S.brand("ProjectId"))
export type ProjectId = S.Schema.Type<typeof ProjectId>

export const DatabaseId = S.String.pipe(S.brand("DatabaseId"))
export type DatabaseId = S.Schema.Type<typeof DatabaseId>

export const ConnectionId = S.String.pipe(S.brand("ConnectionId"))
export type ConnectionId = S.Schema.Type<typeof ConnectionId>

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

export const SqliteConnectionConfig = S.Struct({
  engine: S.Literal("sqlite"),
  filename: S.String,
})
export type SqliteConnectionConfig = S.Schema.Type<typeof SqliteConnectionConfig>

export const ConnectionConfig = S.Union(PostgresConnectionConfig, MysqlConnectionConfig, SqliteConnectionConfig)
export type ConnectionConfig = S.Schema.Type<typeof ConnectionConfig>

