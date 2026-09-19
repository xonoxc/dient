/**
 * Sidebar state. `buildTree` is pure (projects → databases → connections), so
 * it is unit-tested without rendering. `useSidebar` adds lazy loading: a
 * project's databases are fetched when it is expanded, and a database's
 * connections when that is expanded.
 */
import { useEffect, useMemo, useState } from "react"
import { Effect } from "effect"
import { Option } from "effect"
import type { ConfigStoreService } from "@/config"
import type { Connection, Database, DatabaseId, Project, ProjectId } from "@/domain"
import { connectionLabel } from "@/connection/config"

export type SidebarKind = "project" | "database" | "connection"

export interface SidebarNode {
  readonly id: string
  readonly kind: SidebarKind
  readonly refId: string
  readonly label: string
  readonly depth: number
  readonly expandable: boolean
  readonly expanded: boolean
  readonly project?: Project
  readonly database?: Database
  readonly connection?: Connection
}

export interface SidebarData {
  readonly projects: ReadonlyArray<Project>
  readonly databases: ReadonlyMap<ProjectId, ReadonlyArray<Database>>
  readonly connections: ReadonlyMap<DatabaseId, ReadonlyArray<Connection>>
}

const EMPTY: SidebarData = { projects: [], databases: new Map(), connections: new Map() }

/* Flatten the three-level tree in display order, honoring what is expanded. */
export const buildTree = (
  data: SidebarData,
  expanded: ReadonlySet<string>
): ReadonlyArray<SidebarNode> => {
  const nodes: SidebarNode[] = []
  for (const project of data.projects) {
    nodes.push({
      id: `project:${project.id}`,
      kind: "project",
      refId: project.id,
      label: project.name,
      depth: 0,
      expandable: true,
      expanded: expanded.has(project.id),
      project,
    })
    if (!expanded.has(project.id)) continue
    for (const database of data.databases.get(project.id) ?? []) {
      nodes.push({
        id: `database:${database.id}`,
        kind: "database",
        refId: database.id,
        label: database.name,
        depth: 1,
        expandable: true,
        expanded: expanded.has(database.id),
        database,
      })
      if (!expanded.has(database.id)) continue
      for (const connection of data.connections.get(database.id) ?? []) {
        nodes.push({
          id: `connection:${connection.id}`,
          kind: "connection",
          refId: connection.id,
          label: connectionLabel(connection),
          depth: 2,
          expandable: false,
          expanded: false,
          database,
          connection,
        })
      }
    }
  }
  return nodes
}

export interface UseSidebarResult {
  readonly items: ReadonlyArray<SidebarNode>
  readonly cursor: number
  readonly expanded: ReadonlySet<string>
  readonly loaded: boolean
  readonly move: (delta: -1 | 1) => void
  readonly jump: (position: "first" | "last") => void
  readonly toggle: (index: number) => void
  readonly open: (index: number) => void
}

export const useSidebar = (configStore: ConfigStoreService): UseSidebarResult => {
  const [data, setData] = useState<SidebarData>(EMPTY)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [cursor, setCursor] = useState(0)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void Effect.runPromise(configStore.listProjects())
      .then(projects => {
        if (!cancelled) setData(current => ({ ...current, projects }))
      })
      .catch(() => {
        if (!cancelled) setData(EMPTY)
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [configStore])

  const items = useMemo(() => buildTree(data, expanded), [data, expanded])

  const loadDatabases = (projectId: ProjectId): void => {
    void Effect.runPromise(configStore.listDatabases(projectId))
      .then(rows =>
        setData(current => {
          const next = new Map(current.databases)
          next.set(projectId, rows)
          return { ...current, databases: next }
        })
      )
      .catch(() => {
        /* failed load leaves the node collapsed silently */
      })
  }

  const loadConnections = (databaseId: DatabaseId): void => {
    void Effect.runPromise(configStore.listConnections(databaseId))
      .then(rows =>
        setData(current => {
          const next = new Map(current.connections)
          next.set(databaseId, rows)
          return { ...current, connections: next }
        })
      )
      .catch(() => {
        /* failed load leaves the node collapsed silently */
      })
  }

  const toggleExpanded = (index: number): void => {
    const node = items[index]
    if (!node || !node.expandable) return
    const willExpand = !expanded.has(node.refId)
    if (willExpand) {
      if (node.kind === "project") loadDatabases(node.refId as ProjectId)
      else if (node.kind === "database") loadConnections(node.refId as DatabaseId)
    }
    setExpanded(current => {
      const next = new Set(current)
      if (willExpand) next.add(node.refId)
      else next.delete(node.refId)
      return next
    })
  }

  const clamp = (next: number): number => Math.max(0, Math.min(items.length - 1, next))

  return {
    items,
    cursor,
    expanded,
    loaded,
    move: delta => setCursor(c => clamp(c + delta)),
    jump: position => setCursor(position === "first" ? 0 : Math.max(0, items.length - 1)),
    toggle: toggleExpanded,
    open: index => {
      const node = items[index]
      if (!node) return
      if (node.kind === "connection") setCursor(index)
      else toggleExpanded(index)
    },
  }
}

export const selectedConnection = (items: ReadonlyArray<SidebarNode>, index: number): SidebarNode | null => {
  const node = Option.fromNullable(items[index])
  return Option.isSome(node) && node.value.kind === "connection" ? node.value : null
}