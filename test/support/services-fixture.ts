import { Effect, Scope, Context, Layer } from "effect"
import { Database as SqliteDatabase } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildAppLayer } from "@/runtime"
import { ConfigStore, type ConfigStoreService } from "@/config"
import { DatabaseDriver } from "@/drivers/database-driver"
import { SchemaInspector } from "@/inspector"
import { ConnectionManager } from "@/connection/connection-manager"
import { QueryExecutor } from "@/query/query-executor"
import { makeErrorLog } from "@/log/error-log"
import type { AppServices } from "@/app-context"
import type { Connection, Database, Engine, Project } from "@/domain"

export interface TestAppServices {
  readonly services: AppServices
  /** Convenience handle for seeding extra data between tests. */
  readonly store: ConfigStoreService
}

/**
 * Build the real service layer (SQLite config on `configPath`) inside a scope
 * that survives the effect run, so React hooks can keep using the services
 * after this resolves. Mirrors `src/index.tsx`, minus the render loop.
 */
export const buildTestServices = (configPath: string): Effect.Effect<TestAppServices> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const context = yield* Scope.extend(Layer.build(buildAppLayer(configPath)), scope)

    return {
      services: {
        configStore: Context.get(context, ConfigStore),
        connectionManager: Context.get(context, ConnectionManager),
        schemaInspector: Context.get(context, SchemaInspector),
        queryExecutor: Context.get(context, QueryExecutor),
        errorLog: makeErrorLog(`${configPath}.error.log`),
      },
      store: Context.get(context, ConfigStore),
    }
  })

export const resolveTestServices = (configPath: string): Promise<TestAppServices> =>
  Effect.runPromise(buildTestServices(configPath))

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

/** A throwaway file path for the ConfigStore SQLite database. */
export const freshConfigFile = (): string =>
  join(mkdtempSync(join(tmpdir(), "dient-config-")), "config.db")

/** A throwaway SQLite data file, pre-filled with one table of rows. */
export const freshSqliteDataFile = (
  table = "users",
  rows: ReadonlyArray<Record<string, unknown>> = [
    { id: 1, name: "alice", email: "alice@example.com" },
    { id: 2, name: "bob", email: "bob@example.com" },
    { id: 3, name: "carol", email: "carol@example.com" },
  ]
): string => {
  const path = join(mkdtempSync(join(tmpdir(), "dient-data-")), "data.db")
  const db = new SqliteDatabase(path)
  db.run(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)`)
  const insert = db.prepare(`INSERT INTO ${table} (id, name, email) VALUES (?, ?, ?)`)
  const bind = (row: Record<string, unknown>): Array<number | string | null> => [
    row.id as number,
    row.name as string,
    (row.email as string | undefined) ?? null,
  ]
  for (const row of rows) insert.run(...bind(row))
  db.close()
  return path
}

export interface SeededProject {
  readonly project: Project
  readonly database: Database
  readonly connection: Connection
}

/** Seed a project → database → connection chain in the config store. */
export const seedProject = (
  store: ConfigStoreService,
  input: { name: string; database: string; engine: Engine; filename?: string } = {
    name: "demo",
    database: "main",
    engine: "sqlite",
    filename: freshSqliteDataFile(),
  }
): Promise<SeededProject> =>
  run(
    Effect.gen(function* () {
      const project = yield* store.createProject({ name: input.name })
      const database = yield* store.createDatabase({
        projectId: project.id,
        name: input.database,
        engine: input.engine,
      })
      const connection = yield* store.createConnection({
        databaseId: database.id,
        filename: input.filename,
      })
      return { project, database, connection }
    })
  )

export { DatabaseDriver }