/**
 * Finder (telescope-style) index. Builds the searchable universe from the
 * config store — every project, every database with its primary connection,
 * plus the currently opened connection's tables — as a flat list the overlay
 * fuzzy-filters. Selection reuses the explorer's own navigation so a hit lands
 * exactly where pressing Enter on the sidebar row would.
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

export const buildFinderIndex = async (
  configStore: ConfigStoreService,
  activeDatabase: Database | null,
  tables: ReadonlyArray<string>
): Promise<ReadonlyArray<FinderEntry>> => {
  const projects = await Effect.runPromise(configStore.listProjects()).catch(() => [])
  const entries: FinderEntry[] = []
  for (const project of projects) {
    entries.push({
      id: `project:${project.id}`,
      kind: "project",
      label: project.name,
      projectId: project.id,
    })
    const databases = await Effect.runPromise(configStore.listDatabases(project.id)).catch(() => [])
    for (const database of databases) {
      const connections = await Effect.runPromise(configStore.listConnections(database.id)).catch(() => [])
      const primary = connections[0]
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
}