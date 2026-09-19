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
import { Effect } from "effect"
import { useServices, useToasts } from "@/app-context"
import { useSidebar, type SidebarNode } from "@/sidebar/use-sidebar"
import type { ConnectionStatus } from "@/connection/connection-manager"
import type { Connection, ConnectionId, Database } from "@/domain"
import type { ActiveConnection, ColumnInfo } from "@/drivers/types"
import { useTable, type UseTableResult } from "@/table/use-table"

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
  readonly total: number | null
  readonly selectActive: (index?: number) => void
  readonly openTable: (name: string) => void
  readonly cycleConnection: () => void
}

const PAGE_SIZE = 200

const runService = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

export const useExplorer = (): UseExplorerResult => {
  const { configStore, connectionManager, schemaInspector, queryExecutor } = useServices()
  const toasts = useToasts()
  const sidebar = useSidebar(configStore)

  const [focus, setFocus] = useState<PanelFocus>("sidebar")
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({})
  const [active, setActive] = useState<ActiveExplorer | null>(null)
  const [tables, setTables] = useState<ReadonlyArray<string>>([])
  const [tableName, setTableName] = useState<string | null>(null)
  const [rows, setRows] = useState<ReadonlyArray<Record<string, unknown>>>([])
  const [columns, setColumns] = useState<ReadonlyArray<ColumnInfo>>([])
  const [total, setTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
  }, [sidebar.items, active, connectionManager])

  const reportError = (message: string) => {
    setError(message)
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
      })
      .catch(cause => {
        if (gen !== generation.current) return
        setLoading(false)
        reportError(String(cause))
      })
  }

  const selectActive = (index?: number): void => {
    /* Read the *live* cursor and tree so a `j` → `Enter` chord pressed in one
       frame acts on the moved cursor, not the render snapshot. */
    const cursor = index ?? sidebar.cursorRef.current
    const target = sidebar.itemsRef.current[cursor]
    if (!target) return

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
        reportError(`connect failed: ${String(cause)}`)
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

  /* The table keeps its own cursor, but the explorer drives navigation through
     Vim mode, so we advertise the vim cursor (0 default) as the active row. */
  const table = useTable(rows, columns)

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
      total,
      selectActive,
      openTable,
      cycleConnection,
    }),
    [sidebar, focus, statuses, active, tables, loading, error, tableName, table, total]
  )

  return result
}

export type { SidebarNode }

