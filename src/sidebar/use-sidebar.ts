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
import { Deferred, Effect, Fiber, Option } from "effect"
import { useConfigRevision } from "@/app-context"
import type { ConfigStoreService } from "@/config"
import type { Connection, Database, DatabaseId, Project, ProjectId } from "@/domain"

export type SidebarKind = "project" | "database" | "connection" | "table"

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
  /** Table name, for `kind: "table"` leaf nodes under an open connection. */
  readonly table?: string
}

export interface SidebarData {
  readonly projects: ReadonlyArray<Project>
  readonly databases: ReadonlyMap<ProjectId, ReadonlyArray<Database>>
  readonly connections: ReadonlyMap<DatabaseId, ReadonlyArray<Connection>>
}

export type TablesByConnection = Readonly<Record<string, ReadonlyArray<string>>>

const EMPTY: SidebarData = { projects: [], databases: new Map(), connections: new Map() }

/* Flatten the tree in display order, honoring what is expanded. A database is
   a leaf: its (single) connection is folded into the database's row so the
   sidebar reads project → database, matching how users think about a
   database — the connection settings belong to it, not under it. The primary
   (first-stored) connection wins; extra legacy connections are ignored for
   browsing. An active database surfaces its loaded tables as leaves, so the
   sidebar doubles as the table browser. */
export const buildTree = (
  data: SidebarData,
  expanded: ReadonlySet<string>,
  tablesByConnection: TablesByConnection = {}
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
      const connections = data.connections.get(database.id) ?? []
      const primary = connections[0]
      if (!primary) {
        nodes.push({
          id: `database:${database.id}`,
          kind: "database",
          refId: database.id,
          label: database.name,
          depth: 1,
          expandable: false,
          expanded: false,
          database,
        })
        continue
      }
      const connectionExpanded = expanded.has(primary.id)
      nodes.push({
        id: `connection:${primary.id}`,
        kind: "connection",
        refId: primary.id,
        label: database.name,
        depth: 1,
        expandable: true,
        expanded: connectionExpanded,
        database,
        connection: primary,
      })
      if (!connectionExpanded) continue
      for (const table of tablesByConnection[primary.id] ?? []) {
        nodes.push({
          id: `table:${primary.id}:${table}`,
          kind: "table",
          refId: table,
          label: table,
          depth: 2,
          expandable: false,
          expanded: false,
          database,
          connection: primary,
          table,
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
  /** Place the cursor on a node without selecting it (finder jumps). */
  readonly goTo: (index: number) => void
  /** Force a connection node open so a freshly connected connection's tables
      are visible without a second Enter. */
  readonly expandConnection: (connectionId: string) => void
  /** Expand a project and load its databases (and their connections), so
      external callers (e.g. the finder) can select a row that the lazy tree
      has not reached yet. Already-expanded projects resolve immediately. */
  readonly expandProject: (projectId: ProjectId) => Effect.Effect<void>
}

type ReactMutableRef<T> = { readonly current: T }

export const useSidebar = (
  configStore: ConfigStoreService,
  tablesByConnection: TablesByConnection = {}
): UseSidebarResult => {
  /* Mutable truth lives in refs so key handlers can chain against the latest
     state in a single frame; a new immutable snapshot is pushed to state for
     rendering. */
  const dataRef = useRef<SidebarData>(EMPTY)
  const expandedRef = useRef<ReadonlySet<string>>(new Set())
  const cursorRef = useRef(0)
  /* Kept in lockstep with `items`, but updated the instant the tree changes
     (not on the next render). External callers chain off async loads — the
     finder awaits `expandProject` and then indexes this ref — so a stale
     mirror would make them miss nodes the load just added. */
  const itemsRef = useRef<ReadonlyArray<SidebarNode>>(buildTree(EMPTY, new Set()))

  /* In-flight database loads, shared by every caller. The handle is a
     `Deferred`, not a promise: concurrent callers await the same load without
     anything crossing the promise boundary, and interruption completes it
     instead of hanging them. External callers chain off async loads — the
     finder awaits `expandProject` and then indexes this ref — so a stale
     mirror would make them miss nodes the load just added. */
  const inFlight = useRef(new Map<ProjectId, Deferred.Deferred<void>>())

  const [items, setItems] = useState<ReadonlyArray<SidebarNode>>(() => buildTree(EMPTY, new Set()))
  const [cursor, setCursor] = useState(0)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [loaded, setLoaded] = useState(false)
  const { revision, reveal } = useConfigRevision()

  const recompute = (): void => {
    const nextItems = buildTree(dataRef.current, expandedRef.current, tablesByConnection)
    itemsRef.current = nextItems
    setItems(nextItems)
    setCursor(Math.max(0, Math.min(cursorRef.current, nextItems.length - 1)))
    setExpanded(new Set(expandedRef.current))
  }
  const recomputeRef = useRef<(tables: TablesByConnection) => void>(() => undefined)
  recomputeRef.current = tables => {
    const nextItems = buildTree(dataRef.current, expandedRef.current, tables)
    itemsRef.current = nextItems
    setItems(nextItems)
    setCursor(Math.max(0, Math.min(cursorRef.current, nextItems.length - 1)))
  }

  /* New table lists arrive from the explorer after a connect; recompute with
     them so `items` stays a pure function of (data, expanded, tables). */
  useEffect(() => {
    recomputeRef.current(tablesByConnection)
  }, [tablesByConnection])

  /* A committed render is the source of truth for `items`; keep the live mirror
     aligned with it too (the handlers above may have moved it ahead already). */
  itemsRef.current = items

  useEffect(() => {
    /* One program: load, commit to refs, render. Interruption on unmount
       replaces the `cancelled` flag — a torn-down screen runs nothing. */
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const projects = yield* configStore.listProjects().pipe(Effect.orElseSucceed(() => []))
        dataRef.current = { ...dataRef.current, projects }
        yield* Effect.sync(recompute)
        yield* Effect.sync(() => setLoaded(true))
      })
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [configStore])

  /* Another screen mutated the config (settings creating a database, say). The
     sidebar caches databases per project, so it has to drop that cache, re-read,
     and expand the project the caller asked to reveal — otherwise a brand new
     connection exists but the sidebar still shows a collapsed project with
     nothing under it. */
  useEffect(() => {
    if (revision === 0) return
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        /* Drop the sharing handles so post-mutation loads start fresh — but
           complete orphaned deferreds first, or a fiber awaiting one hangs.
           In-flight loaders keep running to completion, as before. */
        yield* Effect.forEach([...inFlight.current.values()], deferred => Deferred.succeed(deferred, undefined), {
          discard: true,
        })
        yield* Effect.sync(() => inFlight.current.clear())
        const projects = yield* configStore.listProjects().pipe(Effect.orElseSucceed(() => []))
        dataRef.current = { ...dataRef.current, projects }
        const targets = reveal ? [reveal] : []
        yield* Effect.all(
          targets.map(projectId => ensureDatabases(projectId as ProjectId)),
          { concurrency: "unbounded" }
        )
        if (targets.length > 0) {
          /* Update the ref synchronously: `recompute` below reads it, and
             `setExpanded` alone would not be visible until the next render. */
          const next = new Set(expandedRef.current)
          for (const projectId of targets) next.add(projectId)
          expandedRef.current = next
          yield* Effect.sync(() => setExpanded(next))
        }
        yield* Effect.sync(recompute)
      })
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [revision]) // eslint-disable-line react-hooks/exhaustive-deps

  /* One project's databases plus every primary connection, as a single
     Effect. Failure folds to "leave the node collapsed" — the tree degrades,
     it never rejects. */
  const loadDatabasesEffect = (projectId: ProjectId): Effect.Effect<void> =>
    Effect.gen(function* () {
      const rows = yield* configStore.listDatabases(projectId).pipe(Effect.orElseSucceed(() => []))
      const databases = new Map(dataRef.current.databases)
      databases.set(projectId, rows)
      /* Databases are leaves now — their (single) connection rides along, so
         the row can show status and connect in one step. Load the primary
         connection's params with the database, not on a later expand. */
      const connections = new Map(dataRef.current.connections)
      const missing = rows.filter(database => !connections.has(database.id))
      const loaded = yield* Effect.all(
        missing.map(database =>
          Effect.map(
            Effect.orElseSucceed(configStore.listConnections(database.id), () => []),
            conns => ({ id: database.id, conns }) as const
          )
        ),
        { concurrency: "unbounded" }
      )
      for (const { id, conns } of loaded) connections.set(id, conns)
      dataRef.current = { ...dataRef.current, databases, connections }
      yield* Effect.sync(recompute)
    })

  /* One logical load per project, shared by every caller. The first caller
     runs the load inline; concurrent callers find its deferred and await the
     same execution. Completion (or interruption) settles the deferred and
     evicts it, so a later call starts fresh — no promise ever changes hands. */
  const ensureDatabases = (projectId: ProjectId): Effect.Effect<void> =>
    Effect.gen(function* () {
      const running = inFlight.current.get(projectId)
      if (running) return yield* Deferred.await(running)
      const done = yield* Deferred.make<void>()
      inFlight.current.set(projectId, done)
      yield* loadDatabasesEffect(projectId).pipe(
        Effect.ensuring(
          Effect.zipRight(
            Deferred.succeed(done, undefined),
            Effect.sync(() => {
              if (inFlight.current.get(projectId) === done) inFlight.current.delete(projectId)
            })
          )
        )
      )
      return yield* Deferred.await(done)
    })

  const loadConnections = (databaseId: DatabaseId): void => {
    Effect.runFork(
      Effect.gen(function* () {
        const rows = yield* configStore.listConnections(databaseId).pipe(Effect.orElseSucceed(() => []))
        const next = new Map(dataRef.current.connections)
        next.set(databaseId, rows)
        dataRef.current = { ...dataRef.current, connections: next }
        yield* Effect.sync(recompute)
      })
    )
  }

  const toggleExpanded = (index: number): void => {
    const node = itemsRef.current[index]
    if (!node || !node.expandable) return

    const willExpand = !expandedRef.current.has(node.refId)
    if (willExpand) {
      if (node.kind === "project") Effect.runFork(ensureDatabases(node.refId as ProjectId))
      else if (node.kind === "database") loadConnections(node.refId as DatabaseId)
    }
    const next = new Set(expandedRef.current)
    if (willExpand) next.add(node.refId)
    else next.delete(node.refId)
    expandedRef.current = next
    recompute()
  }

  const clamp = (next: number): number => Math.max(0, Math.min(itemsRef.current.length - 1, next))

  const expandProject = (projectId: ProjectId): Effect.Effect<void> =>
    Effect.gen(function* () {
      const node = itemsRef.current.find(node => node.kind === "project" && node.refId === projectId)
      if (!node || expandedRef.current.has(projectId)) return
      toggleExpanded(itemsRef.current.indexOf(node))
      /* Await the same shared load a chained keypress may have started —
         no promise involved, just the deferred both sides see. */
      yield* ensureDatabases(projectId)
    })

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
      cursorRef.current = index
      setCursor(index)
      if (node.kind !== "connection" && node.expandable) toggleExpanded(index)
    },
    goTo: index => {
      cursorRef.current = clamp(index)
      setCursor(cursorRef.current)
    },
    expandConnection: connectionId => {
      const next = new Set(expandedRef.current)
      next.add(connectionId)
      expandedRef.current = next
      recompute()
    },
    expandProject,
  }
}

export const selectedConnection = (items: ReadonlyArray<SidebarNode>, index: number): SidebarNode | null => {
  const node = Option.fromNullable(items[index])
  return Option.isSome(node) && node.value.kind === "connection" ? node.value : null
}
