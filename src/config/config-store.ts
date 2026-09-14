import { Context, Data, Effect, Layer } from "effect"
import { Schema as S } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Reactivity } from "@effect/experimental"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { ConnectionId, ConnectionSchema, DatabaseId, DatabaseSchema, ProjectId, ProjectSchema } from "@/domain"
import type { Connection, Database, Engine as EngineType, Project } from "@/domain"
import { runMigrations } from "@/config/migrations"

/**
 * ConfigStore is the service that persists everything the TUI lets the user
 * configure: projects, the databases inside them, and the connections of each
 * database. It is backed by one SQLite file (`~/.dient/config.db` by default)
 * and surfaced through `@effect/sql`'s SqliteClient adapter.
 *
 * Why SQLite instead of a plain JSON config file?
 *   - Writes are atomic and serialized by the engine, so a crash mid-write can
 *     never leave a truncated or half-updated file behind.
 *   - Foreign keys give us cascade deletes "for free": removing a project
 *     removes its databases, and removing a database removes its connections,
 *     all enforced by the database rather than by hand-written cleanup code.
 *   - It stays queryable: we can later filter and sort lists without loading
 *     the whole file.
 *
 * Naming strategy: the domain model is camelCase (see @/domain), but the
 * columns are snake_case. The client is configured with
 * `transformQueryNames`/`transformResultNames` so that camelCase keys we pass
 * to insert/update queries become snake_case columns, and snake_case columns
 * we select become camelCase values again. Raw SQL in this file always spells
 * out snake_case identifiers for table/column names, and column lists in
 * SELECT statements are written out explicitly (never `SELECT *`) so the
 * schema decode below only ever sees the columns we care about.
 *
 * Error handling: SQLite/SQL errors are mapped into a single `ConfigError`
 * tagged error type, so callers only ever need to match on one error type
 * instead of the many the driver can throw.
 */
export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Input shapes. `Create*` picks up all fields the domain schema allows;
 * `Update*` makes every field optional so callers can patch a subset without
 * resending values they did not touch.
 */
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
}

export interface CreateConnectionInput {
  readonly databaseId: DatabaseId
  readonly host?: string
  readonly port?: number
  readonly user?: string
  readonly password?: string
  readonly filename?: string
  readonly defaultDatabase?: string
}

export interface UpdateConnectionInput {
  readonly host?: string
  readonly port?: number
  readonly user?: string
  readonly password?: string
  readonly filename?: string
  readonly defaultDatabase?: string
}

/** The operations callers can run against the store. */
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
}

export class ConfigStore extends Context.Tag("ConfigStore")<ConfigStore, ConfigStoreService>() {}

export namespace ConfigStore {
  /**
   * Build the store against a SQLite file, creating the parent directory and
   * running pending schema migrations on first use.
   *
   * `filepath` defaults to `~/.dient/config.db`; tests pass an explicit
   * throwaway path so they never touch a real config file.
   */
  export const layer = (filepath?: string): Layer.Layer<ConfigStore, never, never> =>
    Layer.scopedContext(
      Effect.gen(function* () {
        const path = filepath ?? join(homedir(), ".dient", "config.db")
        yield* Effect.sync(() => mkdirSync(dirname(path), { recursive: true }))
        const sql = yield* SqliteClient.make({
          filename: path,
          transformQueryNames: camelToSnake,
          transformResultNames: snakeToCamel,
        })
        yield* runMigrations(sql).pipe(Effect.orDie)
        return Context.make(ConfigStore, makeConfigStore(sql))
      })
    ).pipe(Layer.provide(Reactivity.layer))
}

/* ---------------------------------------------------------------------------
 * Small helpers shared by the store implementation.
 * ------------------------------------------------------------------------- */

const camelToSnake = (s: string) => s.replace(/[A-Z]/g, (match) => "_" + match.toLowerCase())
const snakeToCamel = (s: string) => s.replace(/_([a-z])/g, (_match, c: string) => c.toUpperCase())

/*
 * Drops undefined-valued keys. Used before writes so we never persist NULL
 * (or an empty-string column) for an optional field the caller omitted.
 */
const compact = (obj: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined))

/** Generate a new UUID; the same value is what we store and what we return. */
const newId = <T extends string>(): Effect.Effect<T> => Effect.sync(() => crypto.randomUUID() as T)

/*
 * SQLite returns NULL for columns we never wrote; the domain schemas expect
 * `undefined` instead, so NULL values are folded into undefined before decode.
 */
const decodeRow =
  <A, I>(schema: S.Schema<A, I>) =>
  (row: Record<string, unknown>) =>
    S.decodeSync(schema)(
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v ?? undefined])) as I
    )

/* Map every driver/parse failure into a single ConfigError so callers match
   on one error type. The original cause is carried along for debugging. */
const onError = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, ConfigError> =>
  Effect.mapError(effect, (cause) =>
    cause instanceof ConfigError ? cause : new ConfigError({ message: String(cause), cause })
  )

/* --------------------------------------------------------------------------
 * Implementation. Each operation:
 *   1. runs inside a short Effect.gen,
 *   2. decodes whatever came back from SQLite through the matching domain
 *      schema (guaranteeing rows match the domain types), and
 *   3. wraps failures in ConfigError via onError.
 * -------------------------------------------------------------------------- */

const decodeProject = decodeRow(ProjectSchema)
const decodeDatabase = decodeRow(DatabaseSchema)
const decodeConnection = decodeRow(ConnectionSchema)

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

  deleteProject: (id) =>
    onError(
      Effect.gen(function* () {
        /*
         * Foreign keys (with cascade) configured in the migrations remove the
         * databases and connections of this project automatically.
         */
        yield* sql`DELETE FROM projects WHERE id = ${id}`
      })
    ),

  createDatabase: (input) =>
    onError(
      Effect.gen(function* () {
        const id = yield* newId<DatabaseId>()
        const database: Database = { id, ...input }
        yield* sql`INSERT INTO databases ${sql.insert(database)}`
        return database
      })
    ),

  listDatabases: (projectId) =>
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
        /*
         * Only run an UPDATE when the caller actually changed something; the
         * store still returns the (possibly unchanged) stored row so the
         * caller always gets a canonical, decoded value back.
         */
        if (Object.keys(input).length > 0) {
          yield* sql`UPDATE databases SET ${sql.update(compact(input as Record<string, unknown>))} WHERE id = ${id}`
        }
        const rows = yield* sql`SELECT id, project_id, name, engine FROM databases WHERE id = ${id}`
        return decodeDatabase(rows[0]!)
      })
    ),

  deleteDatabase: (id) =>
    onError(
      Effect.gen(function* () {
        /* Cascade removes this database's connections as well. */
        yield* sql`DELETE FROM databases WHERE id = ${id}`
      })
    ),

  createConnection: (input) =>
    onError(
      Effect.gen(function* () {
        const id = yield* newId<ConnectionId>()
        const fields: Record<string, unknown> = { id, ...input }
        yield* sql`INSERT INTO connections ${sql.insert(compact(fields))}`
        return decodeConnection(fields)
      })
    ),

  listConnections: (databaseId) =>
    onError(
      Effect.gen(function* () {
        const rows =
          yield* sql`SELECT id, database_id, host, port, user, password, filename, default_database FROM connections WHERE database_id = ${databaseId}`
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
          yield* sql`SELECT id, database_id, host, port, user, password, filename, default_database FROM connections WHERE id = ${id}`
        return decodeConnection(rows[0]!)
      })
    ),

  deleteConnection: (id) =>
    onError(
      Effect.gen(function* () {
        yield* sql`DELETE FROM connections WHERE id = ${id}`
      })
    ),
})
