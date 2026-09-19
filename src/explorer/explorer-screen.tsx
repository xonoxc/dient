/**
 * Explorer screen — the main browsing surface. Left is the project tree
 * (`Sidebar`), right is the data of whichever table is open. Owns the Vim-mode
 * state for table navigation and feeds the shell's status bar through
 * `SessionProvider`.
 */
import { useEffect, useMemo } from "react"
import { useKeyboard } from "@opentui/react"
import { useTheme } from "@/theme-context"
import { useRouter, useCommandLine, useSessionStatus, useToasts } from "@/app-context"
import { Sidebar } from "@/sidebar/sidebar"
import { DataTable } from "@/table/data-table"
import { useVimMode } from "@/vim"
import { useExplorer } from "@/explorer/use-explorer"
import { connectionLabel } from "@/connection/config"

const TABLE_MOVE_KEYS = new Set(["j", "k", "g", "G"])

export function ExplorerScreen() {
  const theme = useTheme()
  const c = theme.colors
  const router = useRouter()
  const commandLine = useCommandLine()
  const session = useSessionStatus()
  const toasts = useToasts()
  const explorer = useExplorer()
  const { sidebar, focus, setFocus, active, loading, error, tableName, tables } = explorer

  /* Vim mode drives the cursor inside the currently loaded rows. */
  const vim = useVimMode(explorer.table.sortedRows.length)
  const vimMode = vim.mode

  const hints = useMemo(
    () =>
      focus === "sidebar"
        ? ["j/k move", "Enter expand/select", "h/l panels", "Tab next conn", ":/? commands/help"]
        : ["j/k move", "gg/G jump", "h/l panels", "Tab next conn", ":/? commands/help"],
    [focus]
  )

  /* Push the story to the shell's status bar. */
  const { setStatus } = session
  useEffect(() => {
    setStatus({
      mode: vimMode,
      engine: active?.database.engine,
      connection: active ? connectionLabel(active.connection) : undefined,
      database: active?.database.name,
      table: tableName ?? undefined,
      rows: explorer.table.sortedRows.length,
      total: explorer.total ?? undefined,
      hints,
    })
  }, [setStatus, vimMode, active, tableName, explorer.table.sortedRows.length, explorer.total, hints])

  useKeyboard(e => {
    if (router.helpOpen || commandLine.open) return
    const key = e.name

    if (focus === "sidebar") {
      switch (key) {
        case "j":
          sidebar.move(1)
          return
        case "k":
          sidebar.move(-1)
          return
        case "g":
        case "G":
          sidebar.jump(key === "G" ? "last" : "first")
          return
        case "\u001b":
        case "Escape":
          return
      }
      if (key === "enter" || key === "return" || key === "\r") {
        explorer.selectActive()
        return
      }
      if (key === "l" || key === "right") {
        setFocus("table")
        return
      }
    } else {
      if (key === "h" || key === "left") {
        setFocus("sidebar")
        return
      }
      if (key === "i" || key === "v") {
        toasts.push("info", `${key.toUpperCase()} editing lands in a later phase`)
        return
      }
      if (key === "\u001b" || key === "Escape") {
        vim.pressKey(key)
        return
      }
      if (TABLE_MOVE_KEYS.has(key)) {
        vim.pressKey(key)
        return
      }
    }

    switch (key) {
      case "tab":
        explorer.cycleConnection()
        return
      case "enter":
      case "return":
      case "\r":
        if (tableName) {
          /* full cell editor lands in a later phase */
          toasts.push("info", `table ${tableName} is open — editing lands in a later phase`)
        }
        return
    }
  })

  return (
    <box flexGrow={1} flexDirection="row">
      <Sidebar
        items={sidebar.items}
        cursor={sidebar.cursor}
        statuses={explorer.statuses}
        activeConnectionId={active?.connection.id}
        focus={focus === "sidebar"}
      />

      <box flexGrow={1} flexDirection="column">
        <TableStrip tables={tables} tableName={tableName} loading={loading} focus={focus === "table"} />
        {error ? (
          <box flexGrow={1} alignItems="center" justifyContent="center">
            <text fg={c.error}>{error}</text>
          </box>
        ) : loading ? (
          <box flexGrow={1} alignItems="center" justifyContent="center">
            <text fg={c.textMuted}>connecting…</text>
          </box>
        ) : active ? (
          <DataTable table={{ ...explorer.table, cursor: vim.cursor }} viewportRows={16} empty="no rows" />
        ) : (
          <box flexGrow={1} alignItems="center" justifyContent="center">
            <text fg={c.textMuted}>select a connection in the sidebar to start browsing</text>
          </box>
        )}
      </box>
    </box>
  )
}

function TableStrip({
  tables,
  tableName,
  loading,
  focus,
}: {
  tables: ReadonlyArray<string>
  tableName: string | null
  loading: boolean
  focus: boolean
}) {
  const theme = useTheme()
  const c = theme.colors

  if (tables.length === 0 && !loading) {
    return (
      <box height={1} paddingX={1} backgroundColor={c.bgSurface}>
        <text fg={c.textMuted}>{loading ? "loading tables…" : "no tables"}</text>
      </box>
    )
  }

  return (
    <box height={1} paddingX={1} flexDirection="row" backgroundColor={c.bgSurface} overflow="hidden">
      {tables.map(name => {
        const current = name === tableName
        return (
          <box key={name} marginRight={1}>
            <text
              fg={current ? c.textBright : focus ? c.text : c.textMuted}
              bg={current ? c.bgHighlight : undefined}
              truncate
            >
              {current ? "▶ " : ""}
              {name.toUpperCase()}
            </text>
          </box>
        )
      })}
    </box>
  )
}

