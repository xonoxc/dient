/**
 * Explorer screen — the main browsing surface. Left is the project tree
 * (`Sidebar`), right is the data of whichever table is open. Owns the Vim-mode
 * state for table navigation and feeds the shell's status bar through
 * `SessionProvider`.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { Effect, Option } from "effect"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTheme } from "@/theme-context"
import {
  useRouter,
  useCommandLine,
  useDialog,
  useSessionStatus,
  useToasts,
  useServices,
  useTextInput,
  type RoutedKey,
} from "@/app-context"
import { Sidebar } from "@/sidebar/sidebar"
import { SIDEBAR_WIDTH } from "@/sidebar/fit-label"
import { DataTable, type CellDecoration } from "@/table/data-table"
import { selectionRange, useVimMode } from "@/vim"
import { PANEL_ORDER, useExplorer, type ActiveExplorer } from "@/explorer/use-explorer"
import { editRowInEditor } from "@/editor/edit-row-in-editor"
import { editTextInEditor, stripEditorNewline } from "@/editor/edit-text-in-editor"
import { yankRows } from "@/editor/row-clipboard"
import { writeSystemClipboard } from "@/ui/clipboard"
import { formatCell } from "@/table/use-table"
import { useCommand } from "@/app-context"
import { buildFinderIndex, type FinderEntry } from "@/finder/finder"
import { FinderOverlay } from "@/finder/finder-overlay"
import { RowPreview } from "@/explorer/row-preview"
import { useUpdateUi } from "@/update/update-provider"
import { describeError } from "@/errors/describe"
import { CELL_VIEWER_TEXT_WIDTH, CellViewer, wrapText } from "@/explorer/cell-viewer"
import { fuzzyMatch } from "@/finder/fuzzy"
import { normalModeKey, resolveTypedChar } from "@/ui/text-entry"
import { paneIndexForKey } from "@/ui/pane-keys"
import { windowTail } from "@/ui/text-window"
import { LoadingIndicator } from "@/ui/loading-indicator"
import { RabbitMqWorkspace } from "@/rabbitmq/rabbitmq-workspace"
import { RedisStreamPanel, RedisTextPanel } from "@/redis/redis-views"
import { parseRedisRow, redisRowShape, serializeRedisRow } from "@/redis/editing"
import {
  formatTtl,
  redisKeyDetail,
  redisLengthLabel,
  redisTypeLabel,
  redisTypeSymbol,
  redisTypeTone,
} from "@/redis/format"
import type { ThemeColors } from "@/theme"

const TABLE_MOVE_KEYS = new Set(["j", "k", "g", "G"])

/* The symbol + name is wider than the raw type text the table measures, so the
   column needs a floor. */
const REDIS_KEYS_MIN_WIDTHS: Readonly<Record<string, number>> = { type: 9 }

const redisCellDecoration = (
  colors: ThemeColors,
  _row: Readonly<Record<string, unknown>>,
  column: string,
  value: unknown
): CellDecoration | undefined => {
  if (column === "type" && typeof value === "string") {
    return {
      display: `${redisTypeSymbol(value)} ${redisTypeLabel(value)}`,
      fg: colors[redisTypeTone(value)],
    }
  }
  if (column === "ttl") {
    const label = String(value ?? "—")
    return {
      display: label,
      fg: label === "no expiry" ? colors.textMuted : label === "—" ? colors.error : colors.warning,
    }
  }
  return undefined
}

/** Pane numbers are positions in `PANEL_ORDER`, so labels and keys agree. */
const SIDEBAR_PANE = PANEL_ORDER.indexOf("sidebar") + 1
const TABLE_PANE = PANEL_ORDER.indexOf("table") + 1

/** Rows the data pane cannot spend on rows: page top padding, table strip,
    column header, command bar, status bar. */
const DATA_PANE_CHROME_ROWS = 5

export function ExplorerScreen() {
  const theme = useTheme()
  const c = theme.colors
  const router = useRouter()
  const dialog = useDialog()
  const commandLine = useCommandLine()
  const session = useSessionStatus()
  const toasts = useToasts()
  const explorer = useExplorer()
  const { sidebar, focus, setFocus, active, loading, error, tableName, tableInfo } = explorer
  const { configStore } = useServices()
  const update = useUpdateUi()

  /* Vim mode drives the cursor inside the currently loaded rows. */
  const vim = useVimMode(explorer.table.sortedRows.length)
  const vimMode = vim.mode

  /* Horizontal column cursor (left/right arrows). Rows are inspected and
     edited whole, so this only decides which column the grid scrolls into
     view. */
  const [editColumn, setEditColumn] = useState(0)

  /* `Enter` on a row opens the preview. A flag, not a captured row: the panel
     reads whatever is under the cursor, so j/k inside it walks the table and a
     save is visible in place without reopening anything. */
  const [previewOpen, setPreviewOpen] = useState(false)

  /* `e` on the active cell opens the full-value viewer over whatever is up
     (table or preview). Same flag-not-capture contract as the preview: the
     panel reads the cursor row and column live. The offset resets on open so
     a reopened value always starts at the top. */
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerOffset, setViewerOffset] = useState(0)

  /* Vim-style delete: `d` is a pending prefix. Pressing `d` again (or any
     non-d key that consumes the prefix) executes the delete. The timeout
     clears the pending state so a slow `d d` chord does not leak into the
     next key. */
  const [pendingDelete, setPendingDelete] = useState(false)
  const pendingDeleteRef = useRef(false)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const armDelete = () => {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    pendingDeleteRef.current = true
    setPendingDelete(true)
    deleteTimerRef.current = setTimeout(() => {
      pendingDeleteRef.current = false
      setPendingDelete(false)
    }, 1000)
  }
  const clearDelete = () => {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    pendingDeleteRef.current = false
    setPendingDelete(false)
  }

  /* Whole-row editing runs in the user's `$EDITOR` over a `column: value` temp
     file, so nothing in the app can swallow a keystroke or drop an edit. Guard
     against re-entering while a session is still open. */
  const renderer = useRenderer()
  const editorBusyRef = useRef(false)

  /* Fill the data pane: the table is virtualized, so showing as many rows as
     the terminal affords makes the two panes read the same height, as in a GUI
     client. Over-reserving here stays invisible until a jump lands off screen:
     the window renders more rows than the pane can show, the scrollbox clips
     the overflow, and `G` scrolls the cursor past the bottom edge instead of
     onto it. The five rows are the page's top padding, the table strip, the
     column header, the command bar, and the status bar; the page's bottom
     padding is absorbed by the flexible content box and costs no row. */
  const { height, width } = useTerminalDimensions()
  const viewportRows = Math.max(1, height - DATA_PANE_CHROME_ROWS)
  /* Redis keys split into three render modes: the shared data table for
     collections and the keyspace, a wrapped text panel for strings/JSON, and a
     timeline for streams. */
  const redisKeyspace = explorer.redisView?.kind === "keys"
  const redisKeyInfo = explorer.redisView?.kind === "key" ? explorer.redisInfo : null
  const redisJsonMode = redisKeyInfo?.type === "ReJSON-RL" || redisKeyInfo?.type === "json"
  const redisTextMode = explorer.redisView?.kind === "key" && (redisKeyInfo?.type === "string" || redisJsonMode)
  const redisStreamMode = explorer.redisView?.kind === "key" && redisKeyInfo?.type === "stream"
  const redisCustomView = redisTextMode || redisStreamMode
  const redisScrollRef = useRef<ScrollBoxRenderable | null>(null)

  const redisScrollMax = (): number => {
    const box = redisScrollRef.current
    return box ? Math.max(0, box.scrollHeight - box.height) : 0
  }
  const scrollRedis = (delta: number) => {
    const box = redisScrollRef.current
    if (!box) return
    box.scrollTop = Math.max(0, Math.min(redisScrollMax(), box.scrollTop + delta))
  }
  const jumpRedis = (position: "first" | "last") => {
    const box = redisScrollRef.current
    if (!box) return
    box.scrollTop = position === "first" ? 0 : redisScrollMax()
  }
  /* The area the grid gets for its columns: terminal width less the app page
     padding, the sidebar, the leading cursor glyph, and row padding.
     The sidebar width is read from the sidebar rather than repeated here — the
     literal was stale (it said 26 while the sidebar is 32), and every cell of
     the difference became permanent horizontal overflow: the rightmost column
     was always cut off and a scrollbar was always on screen. */
  const dataWidth = Math.max(0, width - 2 - SIDEBAR_WIDTH - 3)
  const previewWidth = Math.max(24, Math.min(96, width - 8))
  const redisDetail =
    explorer.redisView?.kind === "keys"
      ? `db${active?.connection.defaultDatabase || "0"} · ${(explorer.total ?? 0).toLocaleString()} keys`
      : redisKeyInfo
        ? width < 120
          ? `${redisTypeLabel(redisKeyInfo.type)} · ${redisLengthLabel(redisKeyInfo)} · ${formatTtl(redisKeyInfo.ttl)}`
          : redisKeyDetail(redisKeyInfo)
        : null

  /* Never leave the keyboard claimed if the screen goes away mid-edit. */
  useEffect(() => releaseText, [])

  /* `/` search: a ref-backed buffer so a whole chord can be typed and entered
     inside one frame without dropping keys (mirrors the command line). */
  const searchOpenRef = useRef(false)
  const searchBuffer = useRef("")
  const [, bumpSearch] = useState(0)

  /* Search and the finder are text surfaces, so each claims the keyboard while
     open: `:` and `?` are otherwise app-level shortcuts, and both are ordinary
     characters in a query. Claims are taken on open and released on close
     (rather than in an effect) because the open/close state lives in refs, not
     render state. */
  const textInput = useTextInput()

  /* INSERT mode: the finder and `/` search each own the keyboard while open.
     The app dispatcher routes every key to the registered owner and never
     reaches a NORMAL binding, so a query can contain `:` `?` `/` `j` `k` —
     anything. */
  const handleTextKey = (e: RoutedKey): boolean => {
    const key = e.name

    if (finderOpenRef.current) {
      if (key === "\u001b" || key === "Escape" || key === "escape") {
        closeFinder()
        return true
      }
      if (key === "return" || key === "enter" || key === "\r") {
        jumpFinder()
        return true
      }
      if (key === "backspace") {
        finderBackspace()
        return true
      }
      if (key === "down" || (e.ctrl === true && key === "n")) {
        finderMove(1)
        return true
      }
      if (key === "up" || (e.ctrl === true && key === "p")) {
        finderMove(-1)
        return true
      }
      const char = resolveTypedChar(e)
      if (char !== null) finderType(char)
      return true
    }

    if (searchOpenRef.current) {
      if (key === "return" || key === "enter" || key === "\r") {
        closeSearch(true)
        return true
      }
      if (key === "\u001b" || key === "Escape" || key === "escape") {
        closeSearch(false)
        return true
      }
      if (key === "backspace") {
        searchBackspace()
        return true
      }
      const char = resolveTypedChar(e)
      if (char !== null) searchType(char)
      return true
    }

    return false
  }

  /* A single claim for whichever surface is open; released as each one closes.
     The claim installs a trampoline rather than `handleTextKey` itself: a
     claim outlives the render that created it, and jumping the finder needs the
     *current* match list. Reading the newest closure through a ref gives the
     same always-latest semantics the runtime's useEffectEvent provides. */
  const releaseTextRef = useRef<(() => void) | null>(null)
  const liveTextKeyRef = useRef(handleTextKey)
  liveTextKeyRef.current = handleTextKey
  const claimText = (cause?: RoutedKey) => {
    releaseTextRef.current?.()
    releaseTextRef.current = textInput.claim(e => liveTextKeyRef.current(e), cause)
  }
  const releaseText = () => {
    releaseTextRef.current?.()
    releaseTextRef.current = null
  }

  const openSearch = (cause?: RoutedKey) => {
    searchOpenRef.current = true
    searchBuffer.current = ""
    claimText(cause)
    explorer.setSearch("")
    bumpSearch(v => v + 1)
  }
  const closeSearch = (commit: boolean) => {
    searchOpenRef.current = false
    releaseText()
    explorer.setSearch(commit ? searchBuffer.current : "")
    bumpSearch(v => v + 1)
  }
  const searchType = (character: string) => {
    searchBuffer.current += character
    explorer.setSearch(searchBuffer.current)
    bumpSearch(v => v + 1)
  }
  const searchBackspace = () => {
    searchBuffer.current = searchBuffer.current.slice(0, -1)
    explorer.setSearch(searchBuffer.current)
    bumpSearch(v => v + 1)
  }

  /* Finder (telescope-style jump). Space opens it; a chord can be typed in one
     frame so the buffer + open flag live in refs, echoed to state for the
     overlay. The index (projects / databases / tables) rebuilds from the config
     store each time it opens, so it always reflects the latest connections. */
  const finderOpenRef = useRef(false)
  const [finderOpen, setFinderOpen] = useState(false)
  const [finderQuery, setFinderQuery] = useState("")
  const finderQueryRef = useRef("")
  const [finderCursor, setFinderCursor] = useState(0)
  const [finderEntries, setFinderEntries] = useState<ReadonlyArray<FinderEntry>>([])
  const [finderLoading, setFinderLoading] = useState(false)
  const finderRequest = useRef(0)

  const openFinder = (cause?: RoutedKey) => {
    const request = ++finderRequest.current
    finderOpenRef.current = true
    claimText(cause)
    setFinderOpen(true)
    finderQueryRef.current = ""
    setFinderQuery("")
    setFinderCursor(0)
    setFinderEntries([])
    setFinderLoading(true)
    /* The index is one Effect whose every failure already folds to an empty
       universe, so this fork only routes the outcome into current-request
       state — one jump, no promise chain. */
    Effect.runFork(
      Effect.gen(function* () {
        const entries = yield* buildFinderIndex(configStore, active ? active.database : null, explorer.tables)
        if (finderRequest.current !== request) return
        setFinderEntries(entries)
        setFinderLoading(false)
      })
    )
  }

  const closeFinder = () => {
    finderRequest.current++
    finderOpenRef.current = false
    releaseText()
    setFinderOpen(false)
    finderQueryRef.current = ""
    setFinderQuery("")
    setFinderCursor(0)
    setFinderEntries([])
    setFinderLoading(false)
  }
  const finderType = (character: string) => {
    finderQueryRef.current += character
    setFinderQuery(finderQueryRef.current)
    setFinderCursor(0)
  }
  const finderBackspace = () => {
    finderQueryRef.current = finderQueryRef.current.slice(0, -1)
    setFinderQuery(finderQueryRef.current)
    setFinderCursor(0)
  }
  const finderMove = (delta: -1 | 1) => {
    setFinderCursor(current => Math.min(Math.max(0, finderMatches.length - 1), current + delta))
  }

  const finderMatches = useMemo(() => {
    /* Empty query lists everything (tables first, then databases, then
       projects); a query fuzzy-ranks every matching entry. */
    const rank = { project: 0, db: 1, table: 2 } as const
    const scored: Array<{ entry: FinderEntry; score: number }> = []
    for (const entry of finderEntries) {
      const match = fuzzyMatch(finderQuery, entry.label)
      if (!match) continue
      scored.push({ entry, score: match.score })
    }
    scored.sort(
      (a, b) =>
        b.score - a.score || rank[b.entry.kind] - rank[a.entry.kind] || a.entry.label.localeCompare(b.entry.label)
    )
    return scored.slice(0, 10).map(result => result.entry)
  }, [finderEntries, finderQuery])

  const jumpFinder = () => {
    const entry = finderMatches[finderCursor]
    if (!entry) return
    closeFinder()
    if (entry.kind === "table") {
      explorer.openTable(entry.label)
      setFocus("table")
      return
    }
    if (entry.kind === "db") {
      if (entry.projectId && entry.connectionId) {
        explorer.jumpToConnection(entry.projectId, entry.connectionId)
        /* Land on the database row: the cursor highlights it and the `▶`
           active marker appears once the connect it kicks off resolves. */
        setFocus("sidebar")
      } else {
        toasts.push("info", `database "${entry.label}" has no connection — add one from settings`)
      }
      return
    }
    /* project: reveal it in the sidebar and park the cursor on it */
    const index = explorer.sidebar.items.findIndex(node => node.kind === "project" && node.refId === entry.projectId)
    if (index >= 0) explorer.sidebar.open(index)
    setFocus("sidebar")
  }

  /* Explorer-scoped `:` commands. Registered once via the command bus; the
     closures read live explorer state on demand. */
  useCommand({
    id: "explorer:open-table",
    help: ":e <table> — open a table",
    match: text => /^e\s+\S+/.test(text.trim()),
    run: text => {
      const name = text.trim().split(/\s+/)[1] ?? ""
      explorer.openTable(name)
    },
  })
  useCommand({
    id: "explorer:refresh",
    help: ":refresh — reload the current table",
    match: text => text.trim() === "refresh",
    run: () => {
      if (explorer.redisView?.kind === "key") explorer.openRedisKey(explorer.redisView.key)
      else if (explorer.tableName) explorer.openTable(explorer.tableName)
      else toasts.push("info", "no table open to refresh")
    },
  })
  useCommand({
    id: "explorer:connect",
    help: ":connect <db> — switch to a database",
    match: text => /^connect\s+\S+/.test(text.trim()),
    run: text => {
      const name = text.trim().split(/\s+/)[1] ?? ""
      const items = explorer.sidebar.items
      const index = items.findIndex(
        node =>
          node.kind === "connection" &&
          (node.label === name || node.database?.name === name || node.connection?.id === name)
      )
      if (index < 0) {
        toasts.push("error", `no database named "${name}"`)
        return
      }
      explorer.selectActive(index)
    },
  })

  const editRedisCurrent = () => {
    const view = explorer.redisView
    const info = explorer.redisInfo
    const row = explorer.table.sortedRows[vim.cursor]
    if (!active || !view) {
      toasts.push("error", "no Redis value open to edit")
      return
    }

    if (view.kind === "keys") {
      const key = typeof row?.key === "string" ? row.key : null
      if (!key) {
        toasts.push("info", "no keys to rename")
        return
      }
      editorBusyRef.current = true
      editTextInEditor({
        renderer,
        label: `key "${key}"`,
        filename: `key-${key}`,
        content: key,
        callbacks: {
          notice: message => toasts.push("info", message),
          error: message => toasts.push("error", message),
          onSave: edited => {
            const next = stripEditorNewline(edited, key)
            if (next.trim() === "") {
              toasts.push("error", "key name cannot be empty")
              return
            }
            if (next === key) {
              toasts.push("info", "no changes to save")
              return
            }
            explorer.renameRedisKey(key, next)
          },
          done: () => {
            editorBusyRef.current = false
          },
        },
      })
      return
    }

    if (!info) {
      toasts.push("error", "no Redis value open to edit")
      return
    }

    const isJson = info.type === "ReJSON-RL" || info.type === "json"
    if (info.type === "string" || isJson) {
      editorBusyRef.current = true
      explorer.readRedisText(
        text => {
          editTextInEditor({
            renderer,
            label: info.key,
            filename: info.key,
            extension: isJson ? ".json" : ".txt",
            watch: true,
            content: text,
            callbacks: {
              notice: message => toasts.push("info", message),
              error: message => toasts.push("error", message),
              onSave: edited => {
                const value = stripEditorNewline(edited, text)
                if (isJson) {
                  const trimmed = value.trim()
                  try {
                    JSON.parse(trimmed)
                  } catch (cause) {
                    toasts.push("error", `invalid JSON: ${describeError(cause)}`)
                    return
                  }
                  if (trimmed === text) {
                    return
                  }
                  explorer.saveRedisText(trimmed)
                  return
                }
                if (value === text) {
                  return
                }
                explorer.saveRedisText(value)
              },
              done: () => {
                editorBusyRef.current = false
              },
            },
          })
        },
        () => {
          editorBusyRef.current = false
        }
      )
      return
    }

    const shape = redisRowShape(info.type)
    if (!shape) {
      toasts.push("info", `editing ${info.type} values is not supported`)
      return
    }
    if (!row) {
      toasts.push("info", "no rows to edit")
      return
    }
    editorBusyRef.current = true
    editTextInEditor({
      renderer,
      label: info.key,
      filename: info.key,
      content: serializeRedisRow(shape.columns, row),
      callbacks: {
        notice: message => toasts.push("info", message),
        error: message => toasts.push("error", message),
        onSave: edited => {
          const parsed = parseRedisRow(edited, shape.columns, shape.primaryKey, row)
          if (!parsed.ok) {
            toasts.push("error", parsed.error)
            return
          }
          if (parsed.updates.length === 0) {
            toasts.push("info", "no changes to save")
            return
          }
          explorer.saveRedisRow(row, parsed.updates)
        },
        done: () => {
          editorBusyRef.current = false
        },
      },
    })
  }

  const editCurrentRow = () => {
    if (!tableName || !active) {
      toasts.push("error", "no table open to edit")
      return
    }
    if (editorBusyRef.current) return
    if (active.database.engine === "redis") {
      editRedisCurrent()
      return
    }
    if (!tableInfo || tableInfo.primaryKey.length === 0) {
      toasts.push("error", `table ${tableName} has no primary key — can't edit rows`)
      return
    }
    const row = explorer.table.sortedRows[vim.cursor]
    if (!row) {
      toasts.push("info", "no rows to edit")
      return
    }
    editorBusyRef.current = true
    editRowInEditor({
      renderer,
      tableName,
      columns: tableInfo.columns,
      primaryKey: tableInfo.primaryKey,
      row,
      callbacks: {
        notice: message => toasts.push("info", message),
        error: message => toasts.push("error", message),
        onChanges: updates => void explorer.saveRow(row, updates),
        done: () => {
          editorBusyRef.current = false
        },
      },
    })
  }

  /* `V` opens a linewise row selection anchored on the cursor; a table with no
     rows has nothing to select, which is said out loud rather than looking like
     a dead key. */
  const enterVisualMode = () => {
    if (!active || explorer.table.sortedRows.length === 0) {
      toasts.push("info", "no rows to select")
      return
    }
    vim.pressKey("V")
  }

  /* Vim yank: every row the open visual selection spans. The text is the row
     editor's `column: value` pairs with the comment header dropped, so it
     pastes back as data rather than as instructions. */
  const copyRows = () => {
    if (!tableName || !active) {
      toasts.push("error", "no table open to copy from")
      return
    }
    const columns =
      tableInfo?.columns ??
      explorer.table.columns.map(column => ({ name: column.name, type: column.type ?? "text", nullable: true }))
    const yank = yankRows(columns, explorer.table.sortedRows, vim.cursor, vim.selection)
    if (!yank) {
      toasts.push("error", columns.length > 0 ? "no rows to copy" : `table ${tableName} has no columns to copy`)
      return
    }
    const { text, count } = yank
    Effect.runFork(
      Effect.gen(function* () {
        const result = yield* writeSystemClipboard(text, renderer)
        if (result.ok) {
          toasts.push("info", `copied ${count} row${count === 1 ? "" : "s"} to the clipboard`)
        } else {
          toasts.push("error", "could not write to the clipboard")
        }
      })
    )
  }

  /* Redis keyspace: `dd` deletes the key under the cursor. */
  const deleteRedisKeyRow = () => {
    const row = explorer.table.sortedRows[vim.cursor]
    const key = row && typeof row.key === "string" ? row.key : null
    if (!key) {
      toasts.push("info", "no key to delete")
      return
    }
    void dialog
      .confirm({
        title: `Delete key "${key}"?`,
        body: `This removes "${key}" and all of its data from Redis. This cannot be undone.`,
        okLabel: "delete key",
        danger: true,
      })
      .then(ok => {
        if (ok) {
          explorer.deleteRedisKeyByName(key)
        }
      })
  }

  /* Vim-style delete. In NORMAL mode `dd` deletes the cursor row; in VISUAL
     mode `d` deletes the entire selection. Both confirm before touching data. */
  const deleteRows = () => {
    if (!active) {
      toasts.push("error", "no connection open to delete from")
      return
    }
    /* Redis keyspace: `dd` deletes the key under the cursor. */
    if (explorer.redisView?.kind === "keys") {
      deleteRedisKeyRow()
      return
    }
    if (vimMode === "visual" && vim.selection) {
      const sel = Option.getOrNull(vim.selection)
      if (!sel) {
        toasts.push("info", "no selection to delete")
        return
      }
      const range = selectionRange(sel)
      const rows = explorer.table.sortedRows.slice(range.start, range.end + 1)
      if (rows.length === 0) {
        toasts.push("info", "no rows to delete")
        return
      }
      const count = rows.length
      const sample = explorer.table.sortedRows[range.start]
      const preview = sample ? formatCell(Object.values(sample)[0] ?? "") : "row"
      void dialog
        .confirm({
          title: `Delete ${count} row${count === 1 ? "" : "s"}?`,
          body: `This removes ${count} row${count === 1 ? "" : "s"} from ${tableName ?? "the table"}. The first row starts with "${preview}". This cannot be undone.`,
          okLabel: `delete ${count} row${count === 1 ? "" : "s"}`,
          danger: true,
        })
        .then(ok => {
          if (ok) explorer.deleteRows(rows)
        })
      return
    }
    const row = explorer.table.sortedRows[vim.cursor]
    if (!row) {
      toasts.push("info", "no row to delete")
      return
    }
    const sample = formatCell(Object.values(row)[0] ?? "")
    void dialog
      .confirm({
        title: "Delete this row?",
        body: `This removes the row from ${tableName ?? "the table"}. The row starts with "${sample}". This cannot be undone.`,
        okLabel: "delete row",
        danger: true,
      })
      .then(ok => {
        if (ok) explorer.deleteRows([row])
      })
  }

  const hints = useMemo(() => {
    /* While a selection is open those are the only live keys, so the hints name
       them and nothing else — the normal bindings are inert until it closes. */
    if (vimMode === "visual") {
      return [
        "y copy",
        "d delete",
        explorer.redisView?.kind === "keys" ? "i rename key" : "i edit row",
        "Enter preview",
        "j/k extend",
        "gg/G ends",
        "Esc cancel",
      ]
    }

    /* Paging leads the hint list. Hints get a third of the strip, so one buried
       at the end of ten others is never seen — and paging is the one action a
       user cannot discover from the data on screen. */
    const paging: string[] = []
    if (explorer.hasNextPage) paging.push("^f next page")
    if (explorer.hasPrevPage) paging.push("^b prev page")

    /* A pending update outranks the trailing hints: it names its own command,
       so it stays discoverable after the toast expires. */
    const pending: string[] = update.phase === "available" && update.release ? [`${update.release.tag} :upgrade`] : []

    if (focus === "table" && redisCustomView) {
      return [
        ...paging,
        ...pending,
        ...(redisTextMode ? ["i edit value"] : []),
        "j/k scroll",
        "g/G ends",
        "Esc keys",
        "s settings",
        "space jump",
        "1/2 panes",
        "q quit",
      ]
    }
    if (focus === "table" && explorer.redisView?.kind === "keys") {
      return [
        ...paging,
        ...pending,
        "Enter open key",
        "i rename key",
        "dd delete key",
        "j/k move",
        "V select",
        "s settings",
        "space jump",
        "1/2 panes",
        "q quit",
      ]
    }
    if (focus === "table" && explorer.redisView?.kind === "key") {
      return [
        ...paging,
        ...pending,
        "Enter preview",
        "i edit row",
        "dd delete row",
        "e full value",
        "j/k move",
        "h/l cols",
        "Esc keys",
        "s settings",
        "space jump",
        "1/2 panes",
        "q quit",
      ]
    }
    if (focus === "sidebar") {
      return [
        ...paging,
        ...pending,
        "s settings",
        "j/k move",
        "Enter open",
        "space jump",
        "1/2 panes",
        "q quit",
        "? help",
      ]
    }
    if (explorer.search.trim()) return [...paging, `${explorer.searchCount} matches`, "n/N jump", "Esc clear"]
    return [
      ...paging,
      ...pending,
      "s settings",
      "Enter preview",
      "i edit row",
      "dd delete row",
      "V select rows",
      "e full value",
      "j/k move",
      "h/l cols",
      "space jump",
      "gg/G jump",
      "/ search",
      "1/2 panes",
      "q quit",
      "? help",
    ]
  }, [
    focus,
    explorer.search,
    explorer.searchCount,
    explorer.hasNextPage,
    explorer.hasPrevPage,
    redisCustomView,
    redisTextMode,
    explorer.redisView,
    vimMode,
    update.phase,
    update.release,
  ])

  /* The open visual-mode span, normalized, for both the highlighted band and
     the status count. Recomputed from the cursor's selection on every render,
     so it can never drift from the row window it indexes. */
  const selection = Option.getOrNull(vim.selection)
  const selectedRange = selection ? selectionRange(selection) : null
  const selectedCount = selectedRange ? selectedRange.end - selectedRange.start + 1 : undefined

  /* The row the preview is showing. Derived, never captured: the panel and the
     grid therefore cannot disagree about which row is open, and a reload that
     shortens the table under it closes the panel instead of stranding it on a
     row that no longer exists. */
  const previewRow = tableName ? (explorer.table.sortedRows[vim.cursor] ?? null) : null

  /* Rows left for values once the panel's own chrome (title, gap, hint strip,
     the shadow ring's padding) is paid for. */
  const previewMaxRows = Math.max(1, height - 8)

  /* The active cell the `e` viewer shows: cursor row, column cursor. Clamped
     like the grid's own `activeColumn` so the two can never disagree. */
  const viewerColumn =
    explorer.table.columns[Math.min(editColumn, Math.max(explorer.table.columns.length - 1, 0))]?.name ??
    explorer.table.columns[0]?.name ??
    null
  const viewerRow = previewRow
  const viewerValue = viewerRow && viewerColumn ? formatCell(viewerRow[viewerColumn]) : null
  const viewerNeedsExpansion =
    viewerValue !== null &&
    (viewerValue.includes("\n") || viewerValue.length > (explorer.table.widths[viewerColumn!] ?? 4) + 2)

  /* Rows the viewer may spend on wrapped value lines: title, gap, optional
     scroll position, gap, and hint strip all come out of the terminal first. */
  const viewerMaxRows = Math.max(4, Math.min(height - 10, 16))

  const openViewer = () => {
    if (!viewerRow || !viewerColumn || !viewerNeedsExpansion) return
    setViewerOffset(0)
    setViewerOpen(true)
  }

  const scrollViewer = (delta: number) => {
    if (viewerValue === null) return
    const lines = wrapText(viewerValue, CELL_VIEWER_TEXT_WIDTH).length
    setViewerOffset(current => Math.max(0, Math.min(lines - viewerMaxRows, current + delta)))
  }

  const jumpViewer = (where: "first" | "last") => {
    if (viewerValue === null) return
    if (where === "first") {
      setViewerOffset(0)
      return
    }
    const lines = wrapText(viewerValue, CELL_VIEWER_TEXT_WIDTH).length
    setViewerOffset(Math.max(0, lines - viewerMaxRows))
  }

  /* Push the story to the shell's status bar. The database is the connection:
     one name, its engine alongside. */
  const { setStatus } = session
  useEffect(() => {
    if (active?.database.engine === "rabbitmq") return
    setStatus({
      /* Finder and `/` search are text fields: while one is open the session is
         in INSERT mode regardless of the vim mode behind it. */
      mode: textInput.active ? "insert" : vimMode,
      engine: active?.database.engine,
      database: active?.database.name,
      table: tableName ?? undefined,
      rows: explorer.table.sortedRows.length,
      total: explorer.total ?? undefined,
      selected: selectedCount,
      /* Only meaningful when the table is actually paged; a single page of rows
         should just say "200 rows" as before. */
      rowStart: explorer.total !== null && explorer.total > explorer.pageSize ? explorer.offset + 1 : undefined,
      lastQueryMs: explorer.lastQueryMs ?? undefined,
      hints,
    })
  }, [
    setStatus,
    vimMode,
    selectedCount,
    active,
    tableName,
    explorer.table.sortedRows.length,
    explorer.total,
    explorer.offset,
    explorer.pageSize,
    explorer.lastQueryMs,
    hints,
  ])

  useKeyboard(e => {
    /* NORMAL mode only. `route` hands the key to the INSERT-mode owner when
       one exists (the finder, `/` search) and says so; there is nothing to bind
       in that case. */
    if (textInput.route(e)) return
    if (router.helpOpen || commandLine.open) return
    const key = normalModeKey(e)

    /* Number keys focus panes left to right (1 = sidebar, 2 = table). A window
       command like this must stay reachable even while an overlay (preview /
       cell viewer) is open: otherwise the pane switch silently stops working
       the moment a row is inspected, which reads as a broken shortcut. Handle
       it before the overlay guards below. */
    const paneIndex = paneIndexForKey(e, PANEL_ORDER.length)
    if (paneIndex !== null) {
      e.preventDefault()
      setFocus(PANEL_ORDER[paneIndex]!)
      return
    }

    /* RabbitMQ owns a broker workspace rather than the SQL/Redis row grid.
       Keep the shared sidebar navigation and global finder here; the focused
       workspace handles queue, exchange, binding, and message operations. */
    if (active?.database.engine === "rabbitmq") {
      if (key === " " || key === "space") {
        openFinder(e)
        return
      }
      if (focus === "sidebar") {
        if (key === "j" || key === "down") sidebar.move(1)
        else if (key === "k" || key === "up") sidebar.move(-1)
        else if (key === "g" || key === "G") sidebar.jump(key === "G" ? "last" : "first")
        else if (key === "right") setFocus("table")
        else if (key === "S") router.setScreen("settings")
        else if (key === "tab") explorer.cycleConnection()
        else if (key === "enter" || key === "return" || key === "\r") {
          const cursor = sidebar.cursorRef.current
          const current = sidebar.itemsRef.current[cursor]
          if (current?.kind === "connection" && active.connection.id === current.refId) sidebar.toggle(cursor)
          else explorer.selectActive()
        }
      }
      return
    }

    /* The full-value viewer sits above everything (table or preview) while it
       is open and owns the keyboard the same way the preview does: `j`/`k`
       scroll its wrapped lines, and anything else either closes it or stops
       here, so a keystroke can never reach the table underneath. */
    if (viewerOpen) {
      if (
        key === "\u001b" ||
        key === "Escape" ||
        key === "escape" ||
        key === "q" ||
        key === "e" ||
        key === "E" ||
        key === "return" ||
        key === "enter" ||
        key === "\r"
      ) {
        setViewerOpen(false)
        return
      }
      if (key === "j" || key === "down") {
        scrollViewer(1)
        return
      }
      if (key === "k" || key === "up") {
        scrollViewer(-1)
        return
      }
      if (key === "g") {
        jumpViewer("first")
        return
      }
      if (key === "G") {
        jumpViewer("last")
        return
      }
      e.preventDefault()
      return
    }

    /* The preview panel owns the keyboard while it is open. It is a viewer, not
       a field, so it claims no INSERT-mode text input — but every other key has
       to stop here, or `q` would quit the app and `s` would open settings with
       the panel still painted over them. */
    if (previewOpen) {
      if (key === "i") {
        /* Leave the preview up across the `$EDITOR` session: the panel reads
           the cursor row, so coming back shows the row as it now is. */
        editCurrentRow()
        return
      }
      /* The viewer opens over the preview and reads the same cursor row and
         column cursor, so closing it lands back on this panel. */
      if (key === "e" || key === "E") {
        openViewer()
        return
      }
      if (key === "h" || key === "left") {
        setEditColumn(current => Math.max(0, current - 1))
        return
      }
      if (key === "l" || key === "right") {
        setEditColumn(current => Math.min(Math.max(explorer.table.columns.length - 1, 0), current + 1))
        return
      }
      if (key === "\u001b" || key === "Escape" || key === "escape" || key === "q") {
        setPreviewOpen(false)
        return
      }
      if (TABLE_MOVE_KEYS.has(key) || key === "up" || key === "down") {
        vim.pressKey(key === "up" ? "k" : key === "down" ? "j" : key)
        return
      }
      if (key === "g") {
        vim.pressKey("g")
        return
      }
      if (key === "G") {
        vim.pressKey("G")
        return
      }
      e.preventDefault()
      return
    }

    /* `q` quits, but only from NORMAL with nothing modal open — the guards
       above already returned for a text field, the help overlay, and the
       command line. Without a VISUAL check `q` would quit out from under an
       open selection, so it is refused there and the selection keeps it. */
    if (key === "q" && vimMode !== "visual") {
      router.exit(0)
      return
    }

    /* Strings and streams are not tables: j/k scroll the panel and Enter has
       no row to inspect. `i` is still the edit key: strings/JSON open in
       `$EDITOR`, while streams report that Redis entries are append-only. */
    if (focus === "table" && redisCustomView) {
      if (key === "i") {
        editCurrentRow()
        return
      }
      if (e.ctrl === true && key === "f") {
        explorer.nextPage()
        return
      }
      if (e.ctrl === true && key === "b") {
        explorer.prevPage()
        return
      }
      if (key === "j" || key === "down") {
        scrollRedis(1)
        return
      }
      if (key === "k" || key === "up") {
        scrollRedis(-1)
        return
      }
      if (key === "g") {
        jumpRedis("first")
        return
      }
      if (key === "G") {
        jumpRedis("last")
        return
      }
      if (key === "S") {
        router.setScreen("settings")
        return
      }
      if (key === " " || key === "space") {
        openFinder(e)
        return
      }
      if (key === "tab") {
        explorer.cycleConnection()
        return
      }
      if (key === "\u001b" || key === "Escape" || key === "escape") {
        explorer.backToRedisKeys()
        return
      }
      e.preventDefault()
      return
    }

    if (focus === "sidebar") {
      switch (key) {
        /* Paging works from either panel, so a connection can be paged through
           without first moving focus into the data pane. */
        case "f":
          if (e.ctrl === true) {
            explorer.nextPage()
            return
          }
          break
        case "b":
          if (e.ctrl === true) {
            explorer.prevPage()
            return
          }
          break
        case "j":
          sidebar.move(1)
          return
        case "k":
          sidebar.move(-1)
          return
        case "down":
          sidebar.move(1)
          return
        case "up":
          sidebar.move(-1)
          return
        case "g":
        case "G":
          sidebar.jump(key === "G" ? "last" : "first")
          return
        case " ":
        case "space":
          openFinder()
          return
        case "S":
          router.setScreen("settings")
          return
        case "i":
          /* Connect auto-opens the first table but leaves focus here, so row
             editing is reachable from either panel. */
          editCurrentRow()
          return
        case "\u001b":
        case "Escape":
          return
      }
      if (key === "enter" || key === "return" || key === "\r") {
        /* A connection row doubles as a tree node: once it is the active
           connection, Enter should operate the ▾/▸ affordance instead of
           reconnecting and resetting the open table. Connecting still happens
           on the first Enter, when the row is not active yet. */
        const cursor = explorer.sidebar.cursorRef.current
        const current = explorer.sidebar.itemsRef.current[cursor]
        if (current?.kind === "connection" && active?.connection.id === current.refId) {
          explorer.sidebar.toggle(cursor)
          return
        }
        explorer.selectActive()
        return
      }
      /* The right arrow also moves from the sidebar into the table; the
         numbered pane commands (1/2) work from either pane. */
      if (key === "right") {
        setFocus("table")
        return
      }
    } else {
      /* Enter inspects, it never edits: opening `$EDITOR` needs no confirmation,
         and a table is somewhere a stray Return lands all the time. `i` is the
         edit key, here and in VISUAL mode alike, so one muscle memory covers
         both. */
      if (key === "return" || key === "enter" || key === "\r") {
        if (pendingDeleteRef.current) clearDelete()
        if (explorer.redisView?.kind === "keys") {
          const key = explorer.table.sortedRows[vim.cursor]?.key
          if (typeof key === "string") explorer.openRedisKey(key)
          return
        }
        setPreviewOpen(true)
        return
      }

      /* A pending `d` prefix is consumed by any key that isn't `d`/`D`; the
         key then acts normally. This is what makes `dd` a chord rather than a
         double-delete on every other keypress. */
      const consumePending = (action: () => void) => {
        if (pendingDeleteRef.current) {
          clearDelete()
          action()
          return true
        }
        return false
      }

      /* VISUAL mode owns the keyboard: movement extends the linewise selection,
         `y` yanks it and closes, `i` edits the row under the cursor, and every
         other key is swallowed rather than acting on one row while a span is
         highlighted. Swallowing `i` was the one binding that made a live
         selection feel broken — the highlighted rows are the obvious target for
         "edit this", and `i` is the key the hint strip names for it. */
      if (vimMode === "visual") {
        if (key === "y" || key === "Y") {
          if (consumePending(() => {})) return
          copyRows()
          vim.pressKey("escape")
          return
        }
        /* `d` deletes the entire selection with a confirmation, mirroring
           vim's `d` operator in visual mode. */
        if (key === "d" || key === "D") {
          if (pendingDeleteRef.current) {
            clearDelete()
            deleteRows()
            vim.pressKey("escape")
            return
          }
          deleteRows()
          vim.pressKey("escape")
          return
        }
        /* Editing leaves the selection open: the span survives the `$EDITOR`
           session so the rows are still highlighted when the user comes back. */
        if (key === "i") {
          if (consumePending(() => editCurrentRow())) return
          editCurrentRow()
          return
        }
        if (key === "v" || key === "V" || key === "\u001b" || key === "Escape" || key === "escape") {
          if (pendingDeleteRef.current) clearDelete()
          vim.pressKey("escape")
          return
        }
        if (TABLE_MOVE_KEYS.has(key) || key === "up" || key === "down") {
          if (pendingDeleteRef.current) clearDelete()
          vim.pressKey(key === "up" ? "k" : key === "down" ? "j" : key)
        }
        return
      }
      if (key === " " || key === "space") {
        openFinder(e)
        return
      }
      /* Plain h/l scroll the columns (like the arrow keys below) instead of
         switching panes, so a wide table is navigable without the mouse. */
      if (key === "h") {
        setEditColumn(current => Math.max(0, current - 1))
        return
      }
      if (key === "l") {
        setEditColumn(current => Math.min(Math.max(explorer.table.columns.length - 1, 0), current + 1))
        return
      }
      if (key === "S") {
        router.setScreen("settings")
        return
      }
      if (key === "/") {
        openSearch(e)
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
      if (key === "i") {
        editCurrentRow()
        return
      }
      /* `e` expands the active cell: the grid truncates every value to its
         column width, so a long value is only ever a hint that there is more
         until this panel shows it whole. */
      if (key === "e" || key === "E") {
        openViewer()
        return
      }
      /* Page through the table. Ctrl+f / Ctrl+b are chords a printable field
         can never contain, so they stay free in NORMAL mode. */
      if (e.ctrl === true && key === "f") {
        explorer.nextPage()
        return
      }
      if (e.ctrl === true && key === "b") {
        explorer.prevPage()
        return
      }
      /* `V` (and `v`, since a table row is the line) opens a linewise row
         selection anchored here; `j`/`k`/`gg`/`G` extend it and `y` copies it. */
      if (key === "V" || key === "v") {
        enterVisualMode()
        return
      }
      /* Vim-style `dd`: first `d` arms the operator, the second `d` (or `D`)
         deletes the row under the cursor with a confirmation. Any other key
         consumes the pending `d` and acts as usual. */
      if (key === "d" || key === "D") {
        if (pendingDeleteRef.current) {
          clearDelete()
          deleteRows()
          return
        }
        armDelete()
        return
      }
      if (key === "\u001b" || key === "Escape" || key === "escape") {
        clearDelete()
        if (explorer.redisView?.kind === "key") {
          explorer.backToRedisKeys()
          return
        }
        vim.pressKey(key)
        return
      }
      if (TABLE_MOVE_KEYS.has(key) || key === "up" || key === "down") {
        vim.pressKey(key === "up" ? "k" : key === "down" ? "j" : key)
        return
      }
      /* n/N hop between matches inside an active filter (the row window only
         holds matches, so this is next-match / previous-match). */
      if (key === "n" || key === "N") {
        if (explorer.search.trim()) vim.pressKey(key === "n" ? "j" : "k")
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
        paneNumber={SIDEBAR_PANE}
      />

      <box flexGrow={1} flexDirection="column">
        {active?.database.engine === "rabbitmq" ? (
          <RabbitMqWorkspace active={active as ActiveExplorer} focused={focus === "table"} />
        ) : (
          <>
            <TableStrip
              tableName={tableName}
              rawTitle={explorer.redisView?.kind === "key"}
              detail={redisDetail}
              loading={loading}
              focus={focus === "table"}
              paneNumber={TABLE_PANE}
              compact={width < 120}
              offset={explorer.offset}
              rows={explorer.table.sortedRows.length}
              total={explorer.total}
              pageSize={explorer.pageSize}
              hasPrevPage={explorer.hasPrevPage}
              hasNextPage={explorer.hasNextPage}
            />
            {searchOpenRef.current ? (
              <SearchBar query={searchBuffer.current} matches={explorer.searchCount} availableWidth={dataWidth + 3} />
            ) : null}
            {error && dialog.dialog ? (
              <box flexGrow={1} />
            ) : error ? (
              <box flexGrow={1} alignItems="center" justifyContent="center">
                <text fg={c.error}>{error}</text>
              </box>
            ) : loading ? (
              <box flexGrow={1} alignItems="center" justifyContent="center">
                <LoadingIndicator label={tableName ? `loading ${tableName}…` : "connecting…"} />
              </box>
            ) : active ? (
              redisTextMode && explorer.redisPage?.text !== undefined ? (
                <RedisTextPanel
                  value={explorer.redisPage.text}
                  note={explorer.redisPage.note}
                  width={dataWidth}
                  scrollRef={redisScrollRef}
                  json={redisJsonMode}
                />
              ) : redisStreamMode ? (
                <RedisStreamPanel
                  entries={explorer.redisPage?.entries ?? []}
                  width={dataWidth}
                  scrollRef={redisScrollRef}
                />
              ) : (
                <DataTable
                  table={{ ...explorer.table, cursor: vim.cursor }}
                  viewportRows={viewportRows}
                  availableWidth={dataWidth}
                  empty={redisKeyspace ? "no keys" : "no rows"}
                  activeColumn={explorer.table.columns[editColumn]?.name ?? explorer.table.columns[0]?.name}
                  columnFocus={focus === "table"}
                  highlight={explorer.search.trim() || undefined}
                  selection={selectedRange}
                  minWidths={redisKeyspace ? REDIS_KEYS_MIN_WIDTHS : undefined}
                  cellDecoration={
                    redisKeyspace ? (row, column, value) => redisCellDecoration(c, row, column, value) : undefined
                  }
                />
              )
            ) : (
              <box flexGrow={1} alignItems="center" justifyContent="center">
                <text fg={c.textMuted}>select a connection in the sidebar to start browsing</text>
              </box>
            )}
          </>
        )}
      </box>
      {finderOpen ? (
        <FinderOverlay query={finderQuery} entries={finderMatches} cursor={finderCursor} loading={finderLoading} />
      ) : null}
      {previewOpen && previewRow ? (
        <RowPreview
          tableName={tableName!}
          row={previewRow}
          columns={explorer.table.columns}
          primaryKey={tableInfo?.primaryKey ?? []}
          position={vim.cursor + 1}
          total={explorer.table.sortedRows.length}
          maxRows={previewMaxRows}
          activeColumn={viewerColumn ?? undefined}
          width={previewWidth}
          maxHeight={Math.max(8, height - 2)}
          truncated={explorer.table.columns.length > previewMaxRows}
        />
      ) : null}
      {viewerOpen && viewerRow && viewerColumn && viewerValue !== null ? (
        <CellViewer
          tableName={tableName!}
          columnName={viewerColumn}
          columnType={explorer.table.columns.find(column => column.name === viewerColumn)?.type}
          position={vim.cursor + 1}
          total={explorer.table.sortedRows.length}
          value={viewerValue}
          visibleRows={viewerMaxRows}
          offset={viewerOffset}
        />
      ) : null}
    </box>
  )
}

function SearchBar({ query, matches, availableWidth }: { query: string; matches: number; availableWidth: number }) {
  const theme = useTheme()
  const c = theme.colors
  const matchesText = `${matches} matches`
  return (
    <box height={1} paddingX={1} flexDirection="row" alignItems="center" overflow="hidden">
      <text fg={c.accent}>/</text>
      <text fg={c.textBright}>{windowTail(query, availableWidth - 2 - 1 - 1 - matchesText.length - 1)}</text>
      <text fg={c.accent}>▍</text>
      <box flexGrow={1} />
      <text fg={c.textMuted}>{matchesText}</text>
    </box>
  )
}

/**
 * The open table, as a single tab.
 *
 * This used to be a scrolling strip with one tab per table in the database. On
 * a wide schema that meant a hundred tabs in a one-line scroller, and because
 * each tab was its own `<box marginRight={1}>` the layout engine placed every
 * box one column left of where it belonged, so neighbours overwrote each other's
 * last character and long runs fused into nonsense ("PROVIDERRICTEDCOUNTRY").
 * The strip also auto-panned to the active tab, which made a partial window of
 * the list look like the only tables that existed.
 *
 * None of that is worth solving when the answer is "show the open one": there is
 * exactly one tab, so there is no row to lay out and nothing to scroll. The full
 * table list already lives in the sidebar, where it is navigable.
 */
function TableStrip({
  tableName,
  rawTitle = false,
  detail,
  loading,
  focus,
  paneNumber,
  compact,
  offset,
  rows,
  total,
  pageSize,
  hasPrevPage,
  hasNextPage,
}: {
  tableName: string | null
  /** Redis keys are case-sensitive and can contain any character. */
  rawTitle?: boolean
  /** Extra context (Redis type/length/TTL, keyspace DB) shown before paging. */
  detail?: string | null
  loading: boolean
  focus: boolean
  paneNumber: number
  compact: boolean
  offset: number
  rows: number
  total: number | null
  pageSize: number
  hasPrevPage: boolean
  hasNextPage: boolean
}) {
  const theme = useTheme()
  const c = theme.colors

  if (!tableName) {
    return (
      <box height={1} paddingX={1}>
        <text fg={c.textMuted}>{`${paneNumber} ${loading ? "connecting" : "no table open"}`}</text>
      </box>
    )
  }

  return (
    <box height={1} flexDirection="row" overflow="hidden">
      <box height={1} paddingX={1} backgroundColor={c.bgHighlight}>
        <text fg={focus ? c.accent : c.textBright} truncate>
          {`${paneNumber} \u258c ${rawTitle ? tableName : tableName.toUpperCase()}`}
        </text>
      </box>
      <box flexGrow={1} />
      {detail ? (
        <box height={1} paddingX={1} flexShrink={1} overflow="hidden">
          <text fg={c.textMuted} truncate>
            {detail}
          </text>
        </box>
      ) : null}
      {total !== null && total > pageSize ? (
        <box height={1} flexDirection="row" alignItems="center" paddingX={1}>
          <text fg={c.textMuted}>
            {compact ? `${offset + 1}–${offset + rows}/${total}` : `ROWS ${offset + 1}–${offset + rows} / ${total}`}
          </text>
          {!compact ? (
            <>
              <text fg={c.textMuted}> </text>
              <PageTrack offset={offset} pageSize={pageSize} total={total} />
            </>
          ) : null}
          <text fg={hasPrevPage ? c.accent : c.textMuted}>{compact ? " ‹" : "  ‹ ^b"}</text>
          <text fg={hasNextPage ? c.accent : c.textMuted}>{compact ? "  ›" : "   ^f ›"}</text>
        </box>
      ) : null}
    </box>
  )
}

function PageTrack({ offset, pageSize, total }: { offset: number; pageSize: number; total: number }) {
  const { colors: c } = useTheme()
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const ticks = Math.min(10, pages)
  const current = Math.min(ticks - 1, Math.floor((offset / pageSize / pages) * ticks))
  return (
    <box flexDirection="row">
      <text fg={c.accentMuted}>{"━".repeat(current)}</text>
      <text fg={c.accent}>●</text>
      <text fg={c.border}>{"─".repeat(Math.max(0, ticks - current - 1))}</text>
    </box>
  )
}
