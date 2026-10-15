/**
 * Finder (telescope-style) index. Builds the searchable universe from the
 * config store — every project, every database with its primary connection,
 * plus the currently opened connection's tables — as a flat list the overlay
 * fuzzy-filters. Selection reuses the explorer's own navigation so a hit lands
 * exactly where pressing Enter on the sidebar row would.
 *
 * One composed Effect: per-project and per-database loads fan out with
 * `Effect.all`, and a dead store resolves as an empty universe rather than a
 * rejection — the finder with no entries is honest, a crashed finder is not.
 */
import { Effect } from "effect"
import type { ConfigStoreService } from "@/config"
import type { Database, DatabaseId, ProjectId, ConnectionId } from "@/domain"

export type FinderKind = "table" | "db" | "project"

export interface FinderEntry {
  readonly id: string
  readonly kind: FinderKind
  readonly label: string
  /** Contextual suffix: engine for databases. */
  readonly sub?: string
  readonly projectId?: ProjectId
  readonly databaseId?: DatabaseId
  readonly connectionId?: ConnectionId
}

const ENGINE_NAME: Record<string, string> = { postgres: "postgres", mysql: "mysql", sqlite: "sqlite" }

/* One project's databases, each paired with its connections, loaded together.
   Failure degrades to no databases rather than no finder. */
const databasesOf = (configStore: ConfigStoreService, projectId: ProjectId) =>
  Effect.orElseSucceed(configStore.listDatabases(projectId), () => []).pipe(
    Effect.flatMap(databases =>
      Effect.all(
        databases.map(database =>
          Effect.map(
            Effect.orElseSucceed(configStore.listConnections(database.id), () => []),
            connections => ({ database, primary: connections[0] })
          )
        ),
        { concurrency: "unbounded" }
      )
    )
  )

export const buildFinderIndex = (
  configStore: ConfigStoreService,
  activeDatabase: Database | null,
  tables: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<FinderEntry>> =>
  Effect.gen(function* () {
    const projects = yield* Effect.orElseSucceed(configStore.listProjects(), () => [])
    const entries: FinderEntry[] = []
    const perProject = yield* Effect.all(
      projects.map(project => Effect.map(databasesOf(configStore, project.id), databases => ({ project, databases }))),
      { concurrency: "unbounded" }
    )
    for (const { project, databases } of perProject) {
      entries.push({
        id: `project:${project.id}`,
        kind: "project",
        label: project.name,
        projectId: project.id,
      })
      for (const { database, primary } of databases) {
        entries.push({
          id: `database:${database.id}`,
          kind: "db",
          label: database.name,
          sub: ENGINE_NAME[database.engine] ?? database.engine,
          projectId: project.id,
          databaseId: database.id,
          connectionId: primary?.id,
        })
      }
    }
    for (const table of tables) {
      entries.push({
        id: `table:${activeDatabase?.id ?? ""}:${table}`,
        kind: "table",
        label: table,
        projectId: activeDatabase?.projectId,
        databaseId: activeDatabase?.id,
      })
    }
    return entries
  })
