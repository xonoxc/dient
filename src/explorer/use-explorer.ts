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
import { Effect, Option } from "effect"
import { useDialog, useServices, useToasts } from "@/app-context"
import { useSidebar, type SidebarNode, type TablesByConnection } from "@/sidebar/use-sidebar"
import type { ConnectionStatus } from "@/connection/connection-manager"
import type { Connection, ConnectionId, Database, ProjectId } from "@/domain"
import type { ActiveConnection, ColumnInfo } from "@/drivers/types"
import type { TableInfo } from "@/inspector/types"
import { cleanIdentifier } from "@/query/identifier"
import { useTable, type UseTableResult } from "@/table/use-table"
import { formatCell } from "@/table/use-table"

export type PanelFocus = "sidebar" | "table"

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
  readonly search: string
  readonly setSearch: (query: string) => void
  readonly searchCount: number
  readonly selectActive: (index?: number) => void
  readonly openTable: (name: string) => void
  readonly cycleConnection: () => void
  /** Jump to a specific connection from the finder, expanding the containing
      project first if its (lazily loaded) tree has not reached it yet. */
  readonly jumpToConnection: (projectId: ProjectId, connectionId: ConnectionId) => void
  readonly saveCell: (rowIndex: number, column: string, value: string) => Promise<boolean>
  readonly saveRow: (
    row: Record<string, unknown>,
    updates: ReadonlyArray<{ readonly column: string; readonly param: unknown }>
  ) => Promise<boolean>
}

const PAGE_SIZE = 200

const runService = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

/** Case-insensitive substring match across every cell (formatted like the
    table renders them), so `/alice` finds "alice" even in `alice@example.com`. */
export const rowMatches = (row: Record<string, unknown>, query: string): boolean => {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return Object.values(row).some(value => formatCell(value).toLowerCase().includes(needle))
}

export const useExplorer = (): UseExplorerResult => {
  const { configStore, connectionManager, schemaInspector, queryExecutor, errorLog } = useServices()
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
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
    let cancelled = false
    const nodes = sidebar.items.filter(node => node.kind === "connection")
    if (nodes.length === 0) {
      setStatuses({})
      return undefined
    }

    runService(Effect.all(nodes.map(node => connectionManager.statusOf(node.refId as ConnectionId))))
      .then(snapshot => {
        if (cancelled) return
        setStatuses(Object.fromEntries(nodes.map((node, i) => [node.refId, snapshot[i]!])))
      })
      .catch(() => {
        if (!cancelled) setStatuses({})
      })

    return () => {
      cancelled = true
    }
  }, [sidebar.items, active, statusPoll, connectionManager])

  const reportError = (source: string, message: string, cause: unknown) => {
    setError(message)
    errorLog.append(source, cause)
    toasts.push("error", message)
  }

  const openTable = (name: string) => {
    const explorer = activeExplorer.current
    if (!explorer) return
    const gen = ++generation.current
    setLoading(true)
    setError(null)

    runService(
      queryExecutor.loadTable(explorer.id, explorer.database, name, {
        limit: PAGE_SIZE,
        offset: 0,
      })
    )
      .then(result => {
        if (gen !== generation.current) return
        setColumns(result.columns)
        setRows(result.rows)
        setTableName(name)
        setLoading(false)
        return runService(queryExecutor.count(explorer.id, explorer.database, name))
      })
      .then(count => {
        if (gen !== generation.current) return
        setTotal(count ?? null)
        return runService(schemaInspector.describeTable(activeHandle.current!, name))
      })
      .then(info => {
        if (gen !== generation.current) return
        setTableInfo(info !== undefined ? Option.getOrNull(info) : null)
      })
      .catch(cause => {
        if (gen !== generation.current) return
        setLoading(false)
        reportError("explorer.openTable", String(cause), cause)
      })
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

    const previous = activeExplorer.current
    if (previous && previous.id !== node.refId) {
      void runService(connectionManager.disconnect(previous.id)).catch(() => undefined)
      activeExplorer.current = null
      activeHandle.current = null
    }

    runService(connectionManager.connect(node.refId as ConnectionId))
      .then(handle => {
        if (gen !== generation.current) return null

        activeHandle.current = handle
        activeExplorer.current = {
          id: node.refId as ConnectionId,
          connection: node.connection!,
          database: node.database!,
        }
        setActive(activeExplorer.current)

        /* Surface the tables under this connection right away. */
        sidebar.expandConnection(node.refId as ConnectionId)

        return runService(schemaInspector.listTables(handle))
      })
      .then(tableList => {
        if (gen !== generation.current || !tableList) return
        setTables(tableList)
        if (tableList.length > 0) {
          openTable(tableList[0]!)
        } else {
          setTableName(null)
          setRows([])
          setColumns([])
          setTableInfo(null)
          setTotal(null)
          setLoading(false)
        }
      })
      .catch(cause => {
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
        setStatusPoll(poll => poll + 1)
        reportError("explorer.connect", `connect failed: ${String(cause)}`, cause)
        /* Offer a retry so a transient failure (container still booting, host
           offline) recovers from the keyboard instead of forcing navigation. */
        const retryIndex = cursor
        void dialog
          .confirm({
            title: `Connection "${target.connection ? `${target.label} · ${target.database?.name ?? ""}` : target.label}" failed`,
            body: String(cause),
            okLabel: "retry",
            danger: true,
          })
          .then(ok => {
            if (ok) selectActive(retryIndex)
          })
      })
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
       and select once its rows land in the tree. */
    void sidebar.expandProject(projectId).then(reveal)
  }

  const searchedRows = useMemo(
    () => (search.trim() ? rows.filter(row => rowMatches(row, search)) : rows),
    [rows, search]
  )

  /* The table keeps its own cursor, but the explorer drives navigation through
     Vim mode, so we advertise the vim cursor (0 default) as the active row. */
  const table = useTable(searchedRows, columns)

  /* Persist a single-cell edit. The primary key comes from the schema
     inspector's `describeTable`, so the WHERE clause always reaches the exact
     row without trusting a value the user typed. */
  const saveCell = (rowIndex: number, column: string, value: string): Promise<boolean> => {
    const explorer = activeExplorer.current
    if (!explorer || !tableName) {
      toasts.push("error", "nothing open to edit")
      return Promise.resolve(false)
    }
    const row = rows[rowIndex]
    if (!row) return Promise.resolve(false)
    if (!tableInfo) {
      toasts.push("error", `no schema info for ${tableName}`)
      return Promise.resolve(false)
    }
    const pk = tableInfo.primaryKey
    if (pk.length === 0) {
      toasts.push("error", `table ${tableName} has no primary key — can't edit rows`)
      return Promise.resolve(false)
    }
    if (pk.includes(column)) {
      toasts.push("error", `editing the primary key column "${column}" is not supported`)
      return Promise.resolve(false)
    }
    const columnInfo = tableInfo.columns.find(columnInfo => columnInfo.name === column)
    const type = columnInfo?.type ?? ""
    /* Keep numeric cells numeric (whatever the draft looks like) and let a
       blank draft on a nullable column clear the value back to NULL. */
    const param: unknown = /int|bigint|numeric|decimal|real|float|double|money|double_precision/.test(
      type.toLowerCase()
    )
      ? Number(value)
      : value === "" && columnInfo?.nullable
        ? null
        : value
    const engine = explorer.database.engine
    return runService(
      queryExecutor.execute(
        explorer.id,
        `UPDATE ${cleanIdentifier(engine, tableName)} SET ${cleanIdentifier(engine, column)} = ? WHERE ${cleanIdentifier(engine, pk[0]!)} = ?`,
        [param, row[pk[0]!]]
      )
    )
      .then(() => {
        toasts.push("success", `saved ${tableName}.${column}`)
        openTable(tableName)
        return true
      })
      .catch(cause => {
        errorLog.append("explorer.saveCell", cause)
        toasts.push("error", `save failed: ${String(cause)}`)
        return false
      })
  }

  /* Persist a whole edited row: one UPDATE with a SET clause per changed
     field, always keyed on the primary key from the schema inspector. */
  const saveRow = (
    row: Record<string, unknown>,
    updates: ReadonlyArray<{ readonly column: string; readonly param: unknown }>
  ): Promise<boolean> => {
    const explorer = activeExplorer.current
    if (!explorer || !tableName) {
      toasts.push("error", "nothing open to edit")
      return Promise.resolve(false)
    }
    if (!tableInfo) {
      toasts.push("error", `no schema info for ${tableName}`)
      return Promise.resolve(false)
    }
    const pk = tableInfo.primaryKey
    if (pk.length === 0) {
      toasts.push("error", `table ${tableName} has no primary key — can't edit rows`)
      return Promise.resolve(false)
    }
    if (updates.length === 0) {
      toasts.push("info", "no changes to save")
      return Promise.resolve(false)
    }
    const engine = explorer.database.engine
    const sets = updates.map(update => `${cleanIdentifier(engine, update.column)} = ?`).join(", ")
    const where = pk.map(column => `${cleanIdentifier(engine, column)} = ?`).join(" AND ")
    const params = [...updates.map(update => update.param), ...pk.map(column => row[column])]
    return runService(
      queryExecutor.execute(
        explorer.id,
        `UPDATE ${cleanIdentifier(engine, tableName)} SET ${sets} WHERE ${where}`,
        params
      )
    )
      .then(() => {
        const changed = updates.length === 1 ? updates[0]!.column : `${updates.length} columns`
        toasts.push("success", `saved ${tableName}.${changed}`)
        openTable(tableName)
        return true
      })
      .catch(cause => {
        errorLog.append("explorer.saveRow", cause)
        toasts.push("error", `save failed: ${String(cause)}`)
        return false
      })
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
      search,
      setSearch,
      searchCount: searchedRows.length,
      selectActive,
      openTable,
      cycleConnection,
      jumpToConnection,
      saveCell,
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
      search,
      setSearch,
      searchedRows.length,
      saveCell,
      saveRow,
    ]
  )

  return result
}

export type { SidebarNode }
