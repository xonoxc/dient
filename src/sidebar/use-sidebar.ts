/**
 * Sidebar state. `buildTree` is pure (projects → databases → connections), so
 * it is unit-tested without rendering. `useSidebar` holds the tree in mutable
 * refs and pushes new snapshots to state, so a chained keypress such as `j`
 * then `Enter` (both handled in one frame) navigates against the *live* cursor
 * and item list rather than the snapshot from the previous render. Lazy
 * loading: a project's databases are fetched when it is expanded, and a
 * database's connections when that is expanded.
 */
import { useEffect, useRef, useState } from "react"
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
  /* Live mirrors for key handlers that chain actions in one frame: `cursorRef`
     updates the instant `move`/`jump` run, `itemsRef` the instant the tree
     changes. Read these when the effect of a previous press must be visible. */
  readonly cursorRef: ReactMutableRef<number>
  readonly itemsRef: ReactMutableRef<ReadonlyArray<SidebarNode>>
  readonly move: (delta: -1 | 1) => void
  readonly jump: (position: "first" | "last") => void
  readonly toggle: (index: number) => void
  readonly open: (index: number) => void
}

type ReactMutableRef<T> = { readonly current: T }

export const useSidebar = (configStore: ConfigStoreService): UseSidebarResult => {
  /* Mutable truth lives in refs so key handlers can chain against the latest
     state in a single frame; a new immutable snapshot is pushed to state for
     rendering. */
  const dataRef = useRef<SidebarData>(EMPTY)
  const expandedRef = useRef<ReadonlySet<string>>(new Set())
  const cursorRef = useRef(0)
  const loadedRef = useRef(false)

  const [items, setItems] = useState<ReadonlyArray<SidebarNode>>(() => buildTree(EMPTY, new Set()))
  const [cursor, setCursor] = useState(0)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [loaded, setLoaded] = useState(false)

  const recompute = (): void => {
    const nextItems = buildTree(dataRef.current, expandedRef.current)
    setItems(nextItems)
    setCursor(Math.max(0, Math.min(cursorRef.current, nextItems.length - 1)))
    setExpanded(new Set(expandedRef.current))
  }

  const itemsRef = useRef<ReadonlyArray<SidebarNode>>(items)
  itemsRef.current = items

  useEffect(() => {
    let cancelled = false
    void Effect.runPromise(configStore.listProjects())
      .then(projects => {
        if (cancelled) return
        dataRef.current = { ...dataRef.current, projects }
        recompute()
        setLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        dataRef.current = EMPTY
        recompute()
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [configStore])

  const loadDatabases = (projectId: ProjectId): void => {
    void Effect.runPromise(configStore.listDatabases(projectId))
      .then(rows => {
        const next = new Map(dataRef.current.databases)
        next.set(projectId, rows)
        dataRef.current = { ...dataRef.current, databases: next }
        recompute()
      })
      .catch(() => {
        /* failed load leaves the node collapsed silently */
      })
  }

  const loadConnections = (databaseId: DatabaseId): void => {
    void Effect.runPromise(configStore.listConnections(databaseId))
      .then(rows => {
        const next = new Map(dataRef.current.connections)
        next.set(databaseId, rows)
        dataRef.current = { ...dataRef.current, connections: next }
        recompute()
      })
      .catch(() => {
        /* failed load leaves the node collapsed silently */
      })
  }

  const toggleExpanded = (index: number): void => {
    const node = itemsRef.current[index]
    if (!node || !node.expandable) return
    const willExpand = !expandedRef.current.has(node.refId)
    if (willExpand) {
      if (node.kind === "project") loadDatabases(node.refId as ProjectId)
      else if (node.kind === "database") loadConnections(node.refId as DatabaseId)
    }
    const next = new Set(expandedRef.current)
    if (willExpand) next.add(node.refId)
    else next.delete(node.refId)
    expandedRef.current = next
    recompute()
  }

  const clamp = (next: number): number => Math.max(0, Math.min(itemsRef.current.length - 1, next))

  return {
    items,
    cursor,
    expanded,
    loaded,
    cursorRef,
    itemsRef,
    move: delta => {
      cursorRef.current = clamp(cursorRef.current + delta)
      setCursor(cursorRef.current)
    },
    jump: position => {
      cursorRef.current = position === "first" ? 0 : Math.max(0, itemsRef.current.length - 1)
      setCursor(cursorRef.current)
    },
    toggle: toggleExpanded,
    open: index => {
      const node = itemsRef.current[index]
      if (!node) return
      if (node.kind !== "connection") {
        toggleExpanded(index)
        return
      }
      cursorRef.current = index
      setCursor(index)
    },
  }
}

export const selectedConnection = (items: ReadonlyArray<SidebarNode>, index: number): SidebarNode | null => {
  const node = Option.fromNullable(items[index])
  return Option.isSome(node) && node.value.kind === "connection" ? node.value : null
}