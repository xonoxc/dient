import { Context, Data, Effect, Layer } from "effect"
import { Schema as S } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { layer as ReactivityLayer } from "effect/reactivity/Reactivity"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  type ConnectionId,
  ConnectionSchema,
  type DatabaseId,
  DatabaseSchema,
  type ProjectId,
  ProjectSchema,
} from "@/domain"
import type { Connection, Database, Engine as EngineType, Project } from "@/domain"
import { runMigrations } from "@/config/migrations"
import { describeError } from "@/errors/describe"

/**
 * Persists projects, databases, and connections in a SQLite file
 * (`~/.dient/config.db` by default).
 */
export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** Create inputs mirror the domain; update inputs make every field optional for patching. */
export interface CreateProjectInput {
  readonly name: string
}

export interface CreateDatabaseInput {
  readonly projectId: ProjectId
  readonly name: string
  readonly engine: EngineType
}

export interface UpdateDatabaseInput {
  readonly name?: string
  readonly engine?: EngineType
  readonly projectId?: ProjectId
}

export interface CreateConnectionInput {
  readonly databaseId: DatabaseId
  readonly host?: string
  readonly port?: number
  readonly user?: string
  readonly password?: string
  readonly filename?: string
  readonly defaultDatabase?: string
  readonly tls?: boolean
}

export interface UpdateConnectionInput {
  readonly host?: string
  readonly port?: number
  readonly user?: string
  readonly password?: string
  readonly filename?: string
  readonly defaultDatabase?: string
  readonly tls?: boolean
}

export interface ConfigStoreService {
  readonly createProject: (input: CreateProjectInput) => Effect.Effect<Project, ConfigError>
  readonly listProjects: () => Effect.Effect<ReadonlyArray<Project>, ConfigError>
  readonly updateProject: (id: ProjectId, name: string) => Effect.Effect<Project, ConfigError>
  readonly deleteProject: (id: ProjectId) => Effect.Effect<void, ConfigError>

  readonly createDatabase: (input: CreateDatabaseInput) => Effect.Effect<Database, ConfigError>
  readonly listDatabases: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<Database>, ConfigError>
  readonly updateDatabase: (id: DatabaseId, input: UpdateDatabaseInput) => Effect.Effect<Database, ConfigError>
  readonly deleteDatabase: (id: DatabaseId) => Effect.Effect<void, ConfigError>

  readonly createConnection: (input: CreateConnectionInput) => Effect.Effect<Connection, ConfigError>
  readonly listConnections: (databaseId: DatabaseId) => Effect.Effect<ReadonlyArray<Connection>, ConfigError>
  readonly updateConnection: (id: ConnectionId, input: UpdateConnectionInput) => Effect.Effect<Connection, ConfigError>
  readonly deleteConnection: (id: ConnectionId) => Effect.Effect<void, ConfigError>
  readonly findConnection: (
    id: ConnectionId
  ) => Effect.Effect<{ readonly connection: Connection; readonly database: Database }, ConfigError>
}

export class ConfigStore extends Context.Service<ConfigStore, ConfigStoreService>()("ConfigStore") {}

export namespace ConfigStore {
  /**
   * Builds the store at `filepath` (default `~/.dient/config.db`), creating the
   * directory and running pending migrations.
   */
  export const layer = (filepath?: string): Layer.Layer<ConfigStore, never, never> =>
    Layer.effectContext(
      Effect.gen(function* () {
        const path = filepath ?? join(homedir(), ".dient", "config.db")

        yield* Effect.sync(() => mkdirSync(dirname(path), { recursive: true }))

        const sql = yield* SqliteClient.make({
          filename: path,
          transformQueryNames: camelToSnake,
          transformResultNames: snakeToCamel,
        }).pipe(Effect.orDie)

        yield* runMigrations(sql).pipe(Effect.orDie)

        return Context.make(ConfigStore, makeConfigStore(sql))
      })
    ).pipe(Layer.provide(ReactivityLayer))
}

const camelToSnake = (s: string) => s.replace(/[A-Z]/g, match => "_" + match.toLowerCase())
const snakeToCamel = (s: string) => s.replace(/_([a-z])/g, (_match, c: string) => c.toUpperCase())

/* Drops undefined-valued keys so omitted optional fields are not persisted as NULL. */
const compact = (obj: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined))

const newId = <T extends string>(): Effect.Effect<T> => Effect.sync(() => crypto.randomUUID() as T)

/* SQLite returns NULL for unwritten columns; the domain schemas expect undefined. */
const decodeRow =
  <A, I>(schema: S.Codec<A, I>) =>
  (row: Record<string, unknown>) =>
    S.decodeSync(schema)(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v ?? undefined])) as I)

/* Map every driver/parse failure into a single ConfigError, carrying the cause. */
const onError = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, ConfigError> =>
  Effect.mapError(effect, cause =>
    cause instanceof ConfigError
      ? cause
      : new ConfigError({
          message: describeError(cause),
          cause,
        })
  )

const decodeProject = decodeRow(ProjectSchema)
const decodeDatabase = decodeRow(DatabaseSchema)
/* SQLite has no boolean type and returns tls as 0/1; fold it before decode. */
const decodeConnection = (row: Record<string, unknown>): Connection => {
  const tls = row.tls === 1 || row.tls === true ? true : row.tls === 0 || row.tls === false ? false : row.tls
  return decodeRow(ConnectionSchema)({ ...row, tls })
}

const makeConfigStore = (sql: SqliteClient.SqliteClient): ConfigStoreService => ({
  createProject: ({ name }) =>
    onError(
      Effect.gen(function* () {
        const id = yield* newId<ProjectId>()
        const project: Project = { id, name }
        yield* sql`INSERT INTO projects ${sql.insert(project)}`
        return project
      })
    ),

  listProjects: () =>
    onError(
      Effect.gen(function* () {
        const rows = yield* sql`SELECT id, name FROM projects ORDER BY name`
        return rows.map(decodeProject)
      })
    ),

  updateProject: (id, name) =>
    onError(
      Effect.gen(function* () {
        yield* sql`UPDATE projects SET ${sql.update({ name })} WHERE id = ${id}`
        return { id, name } as Project
      })
    ),

  deleteProject: id =>
    onError(
      Effect.gen(function* () {
        /* Foreign-key cascade removes this project's databases and connections. */
        yield* sql`DELETE FROM projects WHERE id = ${id}`
      })
    ),

  createDatabase: input =>
    onError(
      Effect.gen(function* () {
        const id = yield* newId<DatabaseId>()
        const database: Database = { id, ...input }
        yield* sql`INSERT INTO databases ${sql.insert(database)}`
        return database
      })
    ),

  listDatabases: projectId =>
    onError(
      Effect.gen(function* () {
        const rows =
          yield* sql`SELECT id, project_id, name, engine FROM databases WHERE project_id = ${projectId} ORDER BY name`
        return rows.map(decodeDatabase)
      })
    ),

  updateDatabase: (id, input) =>
    onError(
      Effect.gen(function* () {
        /* Skip the UPDATE when nothing changed; always return the stored row. */
        if (Object.keys(input).length > 0) {
          yield* sql`UPDATE databases SET ${sql.update(compact(input as Record<string, unknown>))} WHERE id = ${id}`
        }
        const rows = yield* sql`SELECT id, project_id, name, engine FROM databases WHERE id = ${id}`
        return decodeDatabase(rows[0]!)
      })
    ),

  deleteDatabase: id =>
    onError(
      Effect.gen(function* () {
        /* Cascade removes this database's connections as well. */
        yield* sql`DELETE FROM databases WHERE id = ${id}`
      })
    ),

  createConnection: input =>
    onError(
      Effect.gen(function* () {
        const id = yield* newId<ConnectionId>()
        const fields: Record<string, unknown> = { id, ...input }
        yield* sql`INSERT INTO connections ${sql.insert(compact(fields))}`
        return decodeConnection(fields)
      })
    ),

  listConnections: databaseId =>
    onError(
      Effect.gen(function* () {
        const rows =
          yield* sql`SELECT id, database_id, host, port, user, password, filename, default_database, tls FROM connections WHERE database_id = ${databaseId}`
        return rows.map(decodeConnection)
      })
    ),

  updateConnection: (id, input) =>
    onError(
      Effect.gen(function* () {
        if (Object.keys(input).length > 0) {
          yield* sql`UPDATE connections SET ${sql.update(compact(input as Record<string, unknown>))} WHERE id = ${id}`
        }
        const rows =
          yield* sql`SELECT id, database_id, host, port, user, password, filename, default_database, tls FROM connections WHERE id = ${id}`
        return decodeConnection(rows[0]!)
      })
    ),

  deleteConnection: id =>
    onError(
      Effect.gen(function* () {
        yield* sql`DELETE FROM connections WHERE id = ${id}`
      })
    ),

  findConnection: id =>
    onError(
      Effect.gen(function* () {
        /* One indexed join instead of walking every project/database/connection:
           the db_ aliases keep the database columns apart from the connection's
           own id/database_id, and transformResultNames camelCases them. */
        const rows = yield* sql`
          SELECT c.id, c.database_id, c.host, c.port, c.user, c.password, c.filename, c.default_database, c.tls,
                 d.id AS db_id, d.project_id AS db_project_id, d.name AS db_name, d.engine AS db_engine
          FROM connections c JOIN databases d ON d.id = c.database_id
          WHERE c.id = ${id}
        `
        const row = rows[0]
        if (!row) return yield* Effect.fail(new ConfigError({ message: `no connection with id ${id}` }))
        const { dbId, dbProjectId, dbName, dbEngine, ...connectionFields } = row
        return {
          connection: decodeConnection(connectionFields),
          database: decodeDatabase({ id: dbId, projectId: dbProjectId, name: dbName, engine: dbEngine }),
        }
      })
    ),
})
