import { Effect } from "effect"
import type { SqlError } from "@effect/sql/SqlError"
import type { SqliteClient } from "@effect/sql-sqlite-bun"

/**
 * Schema migrations for the SQLite config database.
 *
 * This is a hand-rolled alternative to the @effect/sql Migrator helper: the
 * config DB only has a couple of DDL statements, and a plain ordered list is
 * easier to read than a loader configuration. The `_migrations` history table
 * tracks which migrations already ran, so `runMigrations` is idempotent
 * across app restarts and safe to retry if a migration fails midway.
 */

/**
 * A single migration. `id` is the ordering key (applied from lowest to
 * highest); `name` is a human-readable label stored in the history table for
 * debugging. Once a migration's `id` is recorded, it never runs again.
 */
export interface Migration {
  readonly id: number
  readonly name: string
  readonly up: (sql: SqliteClient.SqliteClient) => Effect.Effect<void, SqlError>
}

export const migrations: ReadonlyArray<Migration> = [
  {
    id: 1,
    name: "create-config-tables",
    up: sql =>
      Effect.gen(function* () {
        /* Column names are the snake_case form of the camelCase keys passed
           to sql.insert/sql.update (the client's transformQueryNames maps
           them automatically), so they must line up exactly with the domain
           schemas in @/domain. Optional connection fields are nullable
           TEXT/INTEGER columns. */
        yield* sql`CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL
        )`
        yield* sql`CREATE TABLE IF NOT EXISTS databases (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          engine TEXT NOT NULL
        )`
        yield* sql`CREATE TABLE IF NOT EXISTS connections (
          id TEXT PRIMARY KEY,
          database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
          host TEXT,
          port INTEGER,
          user TEXT,
          password TEXT,
          filename TEXT,
          default_database TEXT
        )`
      }),
  },
]

/**
 * Apply every not-yet-applied migration in order. Safe to call on every
 * startup: migrations already present in `_migrations` are skipped.
 */
export const runMigrations = (sql: SqliteClient.SqliteClient): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    /* bun:sqlite keeps foreign keys disabled per connection by default; this
       pragma is what actually turns on the ON DELETE CASCADE behaviour the
       store relies on, so it must run before any table is created/used. */
    yield* sql`PRAGMA foreign_keys = ON`
    yield* sql`CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`

    const rows = yield* sql`SELECT id, name FROM _migrations`
    const applied = new Set(rows.map(row => row.id as number))

    for (const migration of migrations) {
      if (applied.has(migration.id)) continue

      yield* migration.up(sql)

      yield* sql`INSERT INTO _migrations ${sql.insert({
        id: migration.id,
        name: migration.name,
        appliedAt: new Date().toISOString(),
      })}`
    }
  })
