/**
 * Explorer screen state. Owns the connection lifecycle (connect on demand,
 * disconnect on switch), the loaded table list, and the data for whichever
 * table is being viewed, plus what the sidebar shows (which nodes are
 * connected/errored).
 *
 * Every effect is run fire-and-forget from the hook (React is the frame loop,
 * Effect the service boundary), so hooks never block a render.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { Effect, Fiber, Option } from "effect"
import { describeError } from "@/errors/describe"
import { useDialog, useServices, useToasts } from "@/app-context"
import { useSidebar, type SidebarNode, type TablesByConnection } from "@/sidebar/use-sidebar"
import type { ConnectionStatus } from "@/connection/connection-manager"
import type { Connection, ConnectionId, Database, ProjectId } from "@/domain"
import type { ActiveConnection, ColumnInfo } from "@/drivers/types"
import type { TableInfo } from "@/inspector/types"
import { cleanIdentifier } from "@/query/identifier"
import { formatTtl } from "@/redis/format"
import type { RedisKeyInfo, RedisPage } from "@/redis/types"
import { useTable, type UseTableResult } from "@/table/use-table"
import { formatCell } from "@/table/use-table"

export type PanelFocus = "sidebar" | "table"

/**
 * Where a Redis connection currently is: the keyspace browser, or one open key.
 * The key's Redis type lives in `redisInfo`; string/stream/JSON keys render
 * their own panels while the collection types share the data table.
 */
export type RedisView = { readonly kind: "keys" } | { readonly kind: "key"; readonly key: string }

/**
 * Panes in left-to-right layout order. Number key N focuses `PANEL_ORDER[N - 1]`,
 * so the numbering always follows what the user sees rather than a separate
 * id table.
 */
export const PANEL_ORDER = ["sidebar", "table"] as const satisfies ReadonlyArray<PanelFocus>

export interface ActiveExplorer {
  readonly id: ConnectionId
  readonly connection: Connection
  readonly database: Database
}

export interface UseExplorerResult {
  readonly sidebar: ReturnType<typeof useSidebar>
  readonly focus: PanelFocus
  readonly setFocus: (focus: PanelFocus) => void
  readonly statuses: Readonly<Record<string, ConnectionStatus>>
  readonly active: ActiveExplorer | null
  readonly tables: ReadonlyArray<string>
  readonly loading: boolean
  readonly error: string | null
  readonly tableName: string | null
  readonly table: UseTableResult
  readonly tableInfo: TableInfo | null
  readonly total: number | null
  /** Redis keyspace/key view, or null for SQL connections. */
  readonly redisView: RedisView | null
  /** Metadata for the open Redis key (null in the keyspace browser). */
  readonly redisInfo: RedisKeyInfo | null
  /** The open Redis value page, with text/stream payloads for custom views. */
  readonly redisPage: RedisPage | null
  /** Open a key from the keyspace table by name. */
  readonly openRedisKey: (key: string) => void
  /** Return from an open key to the Redis keyspace. */
  readonly backToRedisKeys: () => void
  /** Milliseconds the last page fetch took, or null before the first one. */
  readonly lastQueryMs: number | null
  /** Row offset of the page currently loaded. */
  readonly offset: number
  /** How many rows a page holds. */
  readonly pageSize: number
  /** True when another page exists after this one. */
  readonly hasNextPage: boolean
  /** True when a page exists before this one. */
  readonly hasPrevPage: boolean
  /** Load the next page of rows. No-op on the last page. */
  readonly nextPage: () => void
  /** Load the previous page of rows. No-op on the first page. */
  readonly prevPage: () => void
  readonly search: string
  readonly setSearch: (query: string) => void
  readonly searchCount: number
  readonly selectActive: (index?: number) => void
  readonly openTable: (name: string) => void
  readonly cycleConnection: () => void
  /** Jump to a specific connection from the finder, expanding the containing
      project first if its (lazily loaded) tree has not reached it yet. */
  readonly jumpToConnection: (projectId: ProjectId, connectionId: ConnectionId) => void
  readonly saveRow: (
    row: Record<string, unknown>,
    updates: ReadonlyArray<{ readonly column: string; readonly param: unknown }>
  ) => void
}

const PAGE_SIZE = 200

/**
 * Name the thing that failed to connect.
 *
 * The old title paired `target.label` with `target.database?.name`, but a
 * sidebar connection row is *labelled* with its database and a `Connection`
 * carries no name of its own, so the two were always identical and every
 * failure read `Connection "game_service · game_service" failed`. One
 * name is the whole truth here.
 */
const describeTarget = (target: SidebarNode): string => target.database?.name ?? target.label

/** Case-insensitive substring match across every cell (formatted like the
    table renders them), so `/alice` finds "alice" even in `alice@example.com`. */
export const rowMatches = (row: Record<string, unknown>, query: string): boolean => {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return Object.values(row).some(value => formatCell(value).toLowerCase().includes(needle))
}

export const useExplorer = (): UseExplorerResult => {
  const { configStore, connectionManager, schemaInspector, redisInspector, queryExecutor, errorLog } = useServices()
  const toasts = useToasts()
  const dialog = useDialog()

  const [focus, setFocus] = useState<PanelFocus>("sidebar")
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({})
  const [active, setActive] = useState<ActiveExplorer | null>(null)
  const [tables, setTables] = useState<ReadonlyArray<string>>([])
  const [tableName, setTableName] = useState<string | null>(null)
  const [rows, setRows] = useState<ReadonlyArray<Record<string, unknown>>>([])
  const [columns, setColumns] = useState<ReadonlyArray<ColumnInfo>>([])
  const [tableInfo, setTableInfo] = useState<TableInfo | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [redisView, setRedisView] = useState<RedisView | null>(null)
  const [redisInfo, setRedisInfo] = useState<RedisKeyInfo | null>(null)
  const [redisPage, setRedisPage] = useState<RedisPage | null>(null)
  const [redisNextToken, setRedisNextToken] = useState<string | null>(null)
  const [redisPageIndex, setRedisPageIndex] = useState(0)
  const redisViewRef = useRef<RedisView | null>(null)
  const redisNextTokenRef = useRef<string | null>(null)
  const redisPageIndexRef = useRef(0)
  const redisTokensRef = useRef<Array<string | null>>([null])
  /** Snapshot of the keyspace page a drill-down key was opened from, so Esc
   *  returns to the same SCAN cursor instead of jumping back to page one. */
  const redisKeysReturnRef = useRef<{
    readonly token: string | null
    readonly pageIndex: number
    readonly tokens: ReadonlyArray<string | null>
  } | null>(null)
  /* Rows are paged in the database, not in the view: one `SELECT ... LIMIT n
     OFFSET m` per page, so opening a table on a large production database never
     pulls the whole table into memory. */
  const [offset, setOffset] = useState(0)
  /* The page buttons read this rather than `offset`. Two presses inside one
     render see the same `offset` closure, so paging from state made a fast
     double Ctrl+f load page 2 twice and stall. */
  const offsetRef = useRef(0)
  const [loading, setLoading] = useState(false)
  /* Wall time of the last page fetch, measured from the request to the rows
     landing. A paged query against a large table can be orders of magnitude
     slower than one against a local file, and the difference is invisible
     until you wait for it. */
  const [lastQueryMs, setLastQueryMs] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  /* Recorded from both the page load and the connect/list-tables path: a user
     sitting on the sidebar has still made a round trip, and showing nothing
     there read as a missing feature rather than "no query yet". */
  const noteQueryMs = (startedAt: number) => setLastQueryMs(performance.now() - startedAt)
  const [search, setSearch] = useState("")
  /* Bumping this re-polls the sidebar status dots. A failed connect neither
     changes the tree nor `active`, so without it the dot would stay ○ forever. */
  const [statusPoll, setStatusPoll] = useState(0)

  /* The sidebar mirrors a connected connection's tables as leaf rows so the
     tree doubles as a table browser. Only the active connection's list is
     mounted; switching connections swaps the list. */
  const tablesByConnection = useMemo<TablesByConnection>(
    () => (active ? { [active.id]: tables } : {}),
    [active, tables]
  )
  const sidebar = useSidebar(configStore, tablesByConnection)

  const activeHandle = useRef<ActiveConnection | null>(null)
  const activeExplorer = useRef<ActiveExplorer | null>(null)
  const generation = useRef(0)

  /* Keep the sidebar's per-connection dots fresh as the tree expands and as
     connections connect/disconnect. `active` changes when a connect resolves,
     which is what flips a dot from ○ to ●. `statusOf` never blocks. */
  useEffect(() => {
    const nodes = sidebar.items.filter(node => node.kind === "connection")
    if (nodes.length === 0) {
      setStatuses({})
      return undefined
    }

    /* One program per poll: snapshot every dot, commit once. Failure folds to
       cleared dots; interruption on re-poll/unmount replaces the flag. */
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const snapshot = yield* Effect.all(
          nodes.map(node => connectionManager.statusOf(node.refId as ConnectionId)),
          { concurrency: "unbounded" }
        ).pipe(Effect.orElseSucceed(() => [] as ConnectionStatus[]))
        if (snapshot.length !== nodes.length) {
          yield* Effect.sync(() => setStatuses({}))
          return
        }
        yield* Effect.sync(() =>
          setStatuses(Object.fromEntries(nodes.map((node, i) => [node.refId, snapshot[i]!] as const)))
        )
      })
    )

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [sidebar.items, active, statusPoll, connectionManager])

  const reportError = (source: string, message: string, cause: unknown) => {
    setError(message)
    errorLog.append(source, cause)
    toasts.push("error", message)
  }

  const updateRedisView = (view: RedisView | null): void => {
    redisViewRef.current = view
    setRedisView(view)
  }
  const updateRedisNextToken = (token: string | null): void => {
    redisNextTokenRef.current = token
    setRedisNextToken(token)
  }
  const updateRedisPageIndex = (index: number): void => {
    redisPageIndexRef.current = index
    setRedisPageIndex(index)
  }
  const resetRedis = (): void => {
    updateRedisView(null)
    setRedisInfo(null)
    setRedisPage(null)
    updateRedisNextToken(null)
    updateRedisPageIndex(0)
    redisTokensRef.current = [null]
    redisKeysReturnRef.current = null
  }

  /** Load a keyspace page. SCAN cursors are opaque and one page may contain
   * fewer keys than requested, so the cursor — not an offset — decides whether
   * another page exists. */
  const loadRedisKeys = (token: string | null, pageIndex: number): void => {
    const explorer = activeExplorer.current
    const handle = activeHandle.current
    if (!explorer || explorer.database.engine !== "redis" || !handle) return
    const gen = ++generation.current
    setLoading(true)
    setError(null)
    setRedisInfo(null)
    setRedisPage(null)
    updateRedisNextToken(null)
    const pageOffset = pageIndex * PAGE_SIZE
    offsetRef.current = pageOffset
    setOffset(pageOffset)
    const startedAt = performance.now()

    Effect.runFork(
      Effect.gen(function* () {
        const page = yield* redisInspector.listKeys(handle, { token, count: PAGE_SIZE })
        if (gen !== generation.current) return
        updateRedisView({ kind: "keys" })
        setRedisInfo(null)
        setRedisPage(null)
        setColumns([{ name: "key" }, { name: "type" }, { name: "ttl" }])
        setRows(page.rows.map(row => ({ key: row.key, type: row.type, ttl: formatTtl(row.ttl) })))
        setTableName("keys")
        setTableInfo(null)
        setTotal(page.total)
        updateRedisNextToken(page.nextToken)
        updateRedisPageIndex(pageIndex)
        setLoading(false)
        noteQueryMs(startedAt)
      }).pipe(
        Effect.catchAll(cause =>
          Effect.sync(() => {
            if (gen !== generation.current) return
            setLoading(false)
            reportError("explorer.redisKeys", describeError(cause), cause)
          })
        )
      )
    )
  }

  /** Load one key. The inspector returns a type-specific page: a table for
   * hashes/lists/sets/zsets, plus text or stream entries for the custom views. */
  const loadRedisKey = (key: string, token: string | null, pageIndex: number): void => {
    const explorer = activeExplorer.current
    const handle = activeHandle.current
    if (!explorer || explorer.database.engine !== "redis" || !handle) return
    const gen = ++generation.current
    setLoading(true)
    setError(null)
    setRedisInfo(null)
    setRedisPage(null)
    updateRedisNextToken(null)
    const pageOffset = pageIndex * PAGE_SIZE
    offsetRef.current = pageOffset
    setOffset(pageOffset)
    const startedAt = performance.now()

    Effect.runFork(
      Effect.gen(function* () {
        const page = yield* redisInspector.loadValue(handle, key, { token, count: PAGE_SIZE })
        if (gen !== generation.current) return
        updateRedisView({ kind: "key", key })
        setRedisInfo(page.info)
        setRedisPage(page)
        setColumns(page.columns)
        setRows(page.rows)
        setTableName(key)
        setTableInfo(null)
        setTotal(page.total)
        updateRedisNextToken(page.nextToken)
        updateRedisPageIndex(pageIndex)
        setLoading(false)
        noteQueryMs(startedAt)
      }).pipe(
        Effect.catchAll(cause =>
          Effect.sync(() => {
            if (gen !== generation.current) return
            setLoading(false)
            reportError("explorer.redisKey", describeError(cause), cause)
          })
        )
      )
    )
  }

  const openRedisKeys = (): void => {
    setSearch("")
    redisKeysReturnRef.current = null
    redisTokensRef.current = [null]
    updateRedisPageIndex(0)
    updateRedisView({ kind: "keys" })
    setTableName("keys")
    setTableInfo(null)
    loadRedisKeys(null, 0)
  }

  const openRedisKey = (key: string): void => {
    /* Remember the keyspace page this key came from before resetting the
       per-view cursor stack. A key opened from a command/finder may not have a
       keyspace snapshot; Esc then starts at the first keys page. */
    if (redisViewRef.current?.kind === "keys") {
      const pageIndex = redisPageIndexRef.current
      redisKeysReturnRef.current = {
        token: redisTokensRef.current[pageIndex] ?? null,
        pageIndex,
        tokens: [...redisTokensRef.current],
      }
    }
    setSearch("")
    redisTokensRef.current = [null]
    updateRedisPageIndex(0)
    updateRedisView({ kind: "key", key })
    setTableName(key)
    setTableInfo(null)
    loadRedisKey(key, null, 0)
  }

  const backToRedisKeys = (): void => {
    const saved = redisKeysReturnRef.current
    redisKeysReturnRef.current = null
    if (!saved) {
      openRedisKeys()
      return
    }
    setSearch("")
    redisTokensRef.current = [...saved.tokens]
    updateRedisPageIndex(saved.pageIndex)
    updateRedisView({ kind: "keys" })
    setTableName("keys")
    setTableInfo(null)
    loadRedisKeys(saved.token, saved.pageIndex)
  }

  /** Load one page of `name` at `pageOffset`. The count is only re-read when
      `withCount` is set: paging does not change it, and re-counting a large
      table on every page turn is exactly the load we are trying to avoid. */
  const loadPage = (name: string, pageOffset: number, withCount: boolean): void => {
    const explorer = activeExplorer.current
    if (!explorer) return
    const gen = ++generation.current
    setLoading(true)
    setError(null)
    offsetRef.current = pageOffset
    setOffset(pageOffset)
    /* Sub-millisecond reads are common against a local file, so a millisecond
       clock would report every fetch as 0ms and read as a broken gauge. */
    const startedAt = performance.now()

    /* The whole page pipeline — rows, optional count, schema — as one Effect.
       Generation checks between stages drop stale pages the way the chained
       version did; the terminal `catchAll` reports, so this fork needs no
       promise and no `.catch`. */
    Effect.runFork(
      Effect.gen(function* () {
        const result = yield* queryExecutor.loadTable(explorer.id, explorer.database, name, {
          limit: PAGE_SIZE,
          offset: pageOffset,
        })
        if (gen !== generation.current) return
        setColumns(result.columns)
        setRows(result.rows)
        setTableName(name)
        setLoading(false)
        noteQueryMs(startedAt)
        if (withCount) {
          const count = yield* queryExecutor.count(explorer.id, explorer.database, name)
          if (gen !== generation.current) return
          setTotal(count ?? null)
        }
        const info = yield* schemaInspector.describeTable(activeHandle.current!, name)
        if (gen !== generation.current) return
        setTableInfo(info !== undefined ? Option.getOrNull(info) : null)
      }).pipe(
        Effect.catchAll(cause =>
          Effect.sync(() => {
            if (gen !== generation.current) return
            setLoading(false)
            reportError("explorer.openTable", describeError(cause), cause)
          })
        )
      )
    )
  }

  /** Opening a table always starts at the first page. */
  const openTable = (name: string): void => {
    /* A new table invalidates the old page and any active filter, which only
       ever matched rows on the page that was loaded. */
    setSearch("")
    if (activeExplorer.current?.database.engine === "redis") {
      if (name === "keys") openRedisKeys()
      else openRedisKey(name)
      return
    }
    loadPage(name, 0, true)
  }

  const redisActive = active?.database.engine === "redis"
  const hasNextPage = redisActive ? redisNextToken !== null : total !== null && offset + rows.length < total
  const hasPrevPage = redisActive ? redisPageIndex > 0 : offset > 0

  const nextPage = (): void => {
    if (activeExplorer.current?.database.engine === "redis") {
      const next = redisNextTokenRef.current
      if (!next) return
      const nextIndex = redisPageIndexRef.current + 1
      const tokens = redisTokensRef.current
      if (tokens.length <= nextIndex) tokens.push(next)
      const token = tokens[nextIndex] ?? next
      setSearch("")
      const view = redisViewRef.current
      if (view?.kind === "key") loadRedisKey(view.key, token, nextIndex)
      else loadRedisKeys(token, nextIndex)
      return
    }
    const from = offsetRef.current
    if (!tableName || total === null || from + PAGE_SIZE >= total) return
    /* Filter matches are page-local, so a page turn starts clean. */
    setSearch("")
    loadPage(tableName, from + PAGE_SIZE, false)
  }

  const prevPage = (): void => {
    if (activeExplorer.current?.database.engine === "redis") {
      const previousIndex = redisPageIndexRef.current - 1
      if (previousIndex < 0) return
      const token = redisTokensRef.current[previousIndex] ?? null
      setSearch("")
      const view = redisViewRef.current
      if (view?.kind === "key") loadRedisKey(view.key, token, previousIndex)
      else loadRedisKeys(token, previousIndex)
      return
    }
    const from = offsetRef.current
    if (!tableName || from <= 0) return
    setSearch("")
    loadPage(tableName, Math.max(0, from - PAGE_SIZE), false)
  }

  const selectActive = (index?: number): void => {
    /* Read the *live* cursor and tree so a `j` → `Enter` chord pressed in one
       frame acts on the moved cursor, not the render snapshot. */
    const cursor = index ?? sidebar.cursorRef.current
    const target = sidebar.itemsRef.current[cursor]
    if (!target) return

    /* A table leaf opens straight into the data view. */
    if (target.kind === "table") {
      if (target.table) openTable(target.table)
      setFocus("table")
      return
    }

    /* A database with no stored connection can't be browsed from here. */
    if (target.kind === "database") {
      toasts.push("info", `"${target.label}" has no connection — add one from settings`)
      return
    }

    if (target.kind !== "connection") {
      sidebar.open(index ?? sidebar.cursorRef.current)
      return
    }
    const node = target
    const gen = ++generation.current
    setLoading(true)
    setError(null)
    resetRedis()

    const connectStartedAt = performance.now()
    const previous = activeExplorer.current
    if (previous && previous.id !== node.refId) {
      /* Best effort: a failed disconnect leaves nothing to report. */
      Effect.runFork(Effect.ignore(connectionManager.disconnect(previous.id)))
      activeExplorer.current = null
      activeHandle.current = null
    }

    /* Connect, then list tables, as one Effect: generation checks between the
       stages drop a superseded connect, and the terminal `catchAll` resets
       state, reports, and offers the retry — a single fork, no chain. */
    Effect.runFork(
      Effect.gen(function* () {
        const handle = yield* connectionManager.connect(node.refId as ConnectionId)
        if (gen !== generation.current) return

        activeHandle.current = handle
        activeExplorer.current = {
          id: node.refId as ConnectionId,
          connection: node.connection!,
          database: node.database!,
        }
        setActive(activeExplorer.current)
        noteQueryMs(connectStartedAt)

        /* Surface the tables under this connection right away. */
        sidebar.expandConnection(node.refId as ConnectionId)

        const tableList = handle.engine === "redis" ? ["keys"] : yield* schemaInspector.listTables(handle)
        if (gen !== generation.current) return
        setTables(tableList)
        if (handle.engine === "redis") {
          openRedisKeys()
        } else if (tableList.length > 0) {
          openTable(tableList[0]!)
        } else {
          setTableName(null)
          setRows([])
          setColumns([])
          setTableInfo(null)
          setTotal(null)
          setLoading(false)
        }
      }).pipe(
        Effect.catchAll(cause =>
          Effect.gen(function* () {
            if (gen !== generation.current) return
            activeExplorer.current = null
            activeHandle.current = null
            setActive(null)
            setTables([])
            setTableName(null)
            setRows([])
            setColumns([])
            setTotal(null)
            setLoading(false)
            resetRedis()
            setStatusPoll(poll => poll + 1)
            reportError("explorer.connect", `connect failed: ${describeError(cause)}`, cause)
            /* Offer a retry so a transient failure (container still booting, host
               offline) recovers from the keyboard instead of forcing navigation. */
            const retryIndex = cursor
            const ok = yield* Effect.promise(() =>
              dialog.confirm({
                title: `Connection "${describeTarget(target)}" failed`,
                body: describeError(cause),
                okLabel: "retry",
                danger: true,
              })
            )
            if (ok) selectActive(retryIndex)
          })
        )
      )
    )
  }

  const cycleConnection = (): void => {
    const liveItems = sidebar.itemsRef.current
    const connNodes = liveItems.filter(node => node.kind === "connection")
    if (connNodes.length === 0) return
    const currentIndex = activeExplorer.current
      ? connNodes.findIndex(node => node.refId === activeExplorer.current!.id)
      : -1
    const next = connNodes[(currentIndex + 1) % connNodes.length]!
    const index = liveItems.indexOf(next)
    if (index >= 0) selectActive(index)
  }

  const jumpToConnection = (projectId: ProjectId, connectionId: ConnectionId): void => {
    const liveItems = sidebar.itemsRef.current
    const reveal = (): void => {
      const index = sidebar.itemsRef.current.findIndex(
        node => node.kind === "connection" && node.refId === connectionId
      )
      if (index >= 0) {
        sidebar.goTo(index)
        selectActive(index)
      } else {
        toasts.push("error", "connection not found")
      }
    }
    if (liveItems.some(node => node.kind === "connection" && node.refId === connectionId)) {
      reveal()
      return
    }
    /* The project may be collapsed (its databases not loaded yet); expand it
       and select once its rows land in the tree — one Effect, one fork. */
    Effect.runFork(sidebar.expandProject(projectId).pipe(Effect.andThen(Effect.sync(reveal))))
  }

  const searchedRows = useMemo(
    () => (search.trim() ? rows.filter(row => rowMatches(row, search)) : rows),
    [rows, search]
  )

  /* The table keeps its own cursor, but the explorer drives navigation through
     Vim mode, so we advertise the vim cursor (0 default) as the active row. */
  const table = useTable(searchedRows, columns)

  /* Persist a whole edited row: one UPDATE with a SET clause per changed
     field, always keyed on the primary key from the schema inspector. */
  const saveRow = (
    row: Record<string, unknown>,
    updates: ReadonlyArray<{ readonly column: string; readonly param: unknown }>
  ): void => {
    const explorer = activeExplorer.current
    if (!explorer || !tableName) {
      toasts.push("error", "nothing open to edit")
      return
    }
    if (explorer.database.engine === "redis") {
      toasts.push("info", "Redis browsing is read-only")
      return
    }
    if (!tableInfo) {
      toasts.push("error", `no schema info for ${tableName}`)
      return
    }
    const pk = tableInfo.primaryKey
    if (pk.length === 0) {
      toasts.push("error", `table ${tableName} has no primary key — can't edit rows`)
      return
    }
    if (updates.length === 0) {
      toasts.push("info", "no changes to save")
      return
    }
    const engine = explorer.database.engine
    /* Quoting, the UPDATE, the toast, and the same-page reload compose into
       one Effect: identifier refusal used to throw synchronously out of the
       key handler, now it lands in the same `catchAll` as a failed write. */
    Effect.runFork(
      Effect.gen(function* () {
        const sets = yield* Effect.all(
          updates.map(update => Effect.map(cleanIdentifier(engine, update.column), quoted => `${quoted} = ?`))
        )
        const where = yield* Effect.all(
          pk.map(column => Effect.map(cleanIdentifier(engine, column), quoted => `${quoted} = ?`))
        )
        const table = yield* cleanIdentifier(engine, tableName)
        const params = [...updates.map(update => update.param), ...pk.map(column => row[column])]
        yield* queryExecutor.execute(
          explorer.id,
          `UPDATE ${table} SET ${sets.join(", ")} WHERE ${where.join(" AND ")}`,
          params
        )
        const changed = updates.length === 1 ? updates[0]!.column : `${updates.length} columns`
        toasts.push("success", `saved ${tableName}.${changed}`)
        /* Reload the page we were on, not page 1: the UPDATE targeted this row
           by primary key, so a `openTable` reset would lose the reader's place
           in a long table. An UPDATE cannot change the row count, so the page
           is still valid and the count does not need re-reading. */
        loadPage(tableName, offset, false)
      }).pipe(
        Effect.catchAll(cause =>
          Effect.sync(() => {
            errorLog.append("explorer.saveRow", cause)
            toasts.push("error", `save failed: ${describeError(cause)}`)
          })
        )
      )
    )
  }

  const result = useMemo<UseExplorerResult>(
    () => ({
      sidebar,
      focus,
      setFocus,
      statuses,
      active,
      tables,
      loading,
      error,
      tableName,
      table,
      tableInfo,
      total,
      redisView,
      redisInfo,
      redisPage,
      openRedisKey,
      backToRedisKeys,
      lastQueryMs,
      offset,
      pageSize: PAGE_SIZE,
      hasNextPage,
      hasPrevPage,
      nextPage,
      prevPage,
      search,
      setSearch,
      searchCount: searchedRows.length,
      selectActive,
      openTable,
      cycleConnection,
      jumpToConnection,
      saveRow,
    }),
    [
      sidebar,
      focus,
      statuses,
      active,
      tables,
      loading,
      error,
      tableName,
      table,
      tableInfo,
      total,
      redisView,
      redisInfo,
      redisPage,
      redisNextToken,
      redisPageIndex,
      lastQueryMs,
      offset,
      hasNextPage,
      hasPrevPage,
      searchedRows.length,
      saveRow,
    ]
  )

  return result
}

export type { SidebarNode }
