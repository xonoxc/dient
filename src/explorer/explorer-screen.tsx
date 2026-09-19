/**
 * Explorer screen — the main browsing surface. Left is the project tree
 * (`Sidebar`), right is the data of whichever table is open. Owns the Vim-mode
 * state for table navigation and feeds the shell's status bar through
 * `SessionProvider`.
 */
import { useEffect, useMemo, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { useTheme } from "@/theme-context"
import { useRouter, useCommandLine, useSessionStatus, useToasts } from "@/app-context"
import { Sidebar } from "@/sidebar/sidebar"
import { DataTable } from "@/table/data-table"
import { useVimMode } from "@/vim"
import { useExplorer } from "@/explorer/use-explorer"
import { useCellEditor } from "@/editor/use-cell-editor"
import { formatCell } from "@/table/use-table"
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
  const { sidebar, focus, setFocus, active, loading, error, tableName, tables, tableInfo } = explorer

  /* Vim mode drives the cursor inside the currently loaded rows. */
  const vim = useVimMode(explorer.table.sortedRows.length)
  const vimMode = vim.mode

  /* The cell editor targets one cell: the vim cursor's row and a column cursor
     (right/left arrows), with the draft validated against the schema. */
  const [editColumn, setEditColumn] = useState(0)
  const editor = useCellEditor()

  const commitEdit = () => {
    const target = editor.editTarget()
    if (!target) return
    const editingColumns = tableInfo
      ? tableInfo.columns.map(column => ({ name: column.name, type: column.type }))
      : explorer.table.columns
    const result = editor.commit(editingColumns)
    if (!result) {
      const failure = editor.errorValue()
      if (failure) toasts.push("error", failure)
      return
    }
    editor.cancel()
    void explorer.saveCell(target.rowIndex, target.column, result.value)
  }

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
      /* While a cell is being edited, everything but commit/cancel is text. */
      if (editor.isEditing()) {
        if (key === "return" || key === "enter" || key === "\r") {
          commitEdit()
          return
        }
        if (key === "\u001b" || key === "Escape" || key === "escape" || (e.ctrl === true && key === "c")) {
          editor.cancel()
          return
        }
        if (key === "backspace") {
          editor.backspace()
          return
        }
        if (key === " " || key === "space") {
          editor.type(" ")
          return
        }
        if (key && key.length === 1) {
          editor.type(key)
          return
        }
        return
      }
      if (key === "h" || key === "left") {
        setFocus("sidebar")
        return
      }
      /* arrow keys move the column cursor within the focused row */
      if (key === "right") {
        setEditColumn(current => Math.min(Math.max(explorer.table.columns.length - 1, 0), current + 1))
        return
      }
      if (key === "left") {
        setEditColumn(current => Math.max(0, current - 1))
        return
      }
      if (key === "i" || key === "v") {
        toasts.push("info", `${key.toUpperCase()} editing lands in a later phase`)
        return
      }
      if (key === "\u001b" || key === "Escape" || key === "escape") {
        vim.pressKey(key)
        return
      }
      if (TABLE_MOVE_KEYS.has(key)) {
        vim.pressKey(key)
        return
      }
      if (key === "return" || key === "enter" || key === "\r") {
        if (tableName && active) {
          const row = explorer.table.sortedRows[vim.cursor]
          const column = explorer.table.columns[editColumn]?.name ?? explorer.table.columns[0]?.name
          if (row && column) {
            const current = row[column]
            editor.open({
              rowIndex: vim.cursor,
              column,
              original: current === null || current === undefined ? "" : formatCell(current),
            })
          }
        }
        return
      }
    }

    switch (key) {
      case "tab":
        explorer.cycleConnection()
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
          <DataTable table={{ ...explorer.table, cursor: vim.cursor }} viewportRows={16} empty="no rows" editing={editor.preview} />
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

