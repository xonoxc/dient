/**
 * Explorer screen — the main browsing surface. Left is the project tree
 * (`Sidebar`), right is the data of whichever table is open. Owns the Vim-mode
 * state for table navigation and feeds the shell's status bar through
 * `SessionProvider`.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTheme } from "@/theme-context"
import { useRouter, useCommandLine, useSessionStatus, useToasts, useServices, useTextInput, type RoutedKey } from "@/app-context"
import { Sidebar } from "@/sidebar/sidebar"
import { DataTable } from "@/table/data-table"
import { useVimMode } from "@/vim"
import { useExplorer } from "@/explorer/use-explorer"
import { useCellEditor } from "@/editor/use-cell-editor"
import { editRowInEditor } from "@/editor/edit-row-in-editor"
import { formatCell } from "@/table/use-table"
import { useCommand } from "@/app-context"
import { buildFinderIndex, type FinderEntry } from "@/finder/finder"
import { FinderOverlay } from "@/finder/finder-overlay"
import { fuzzyMatch } from "@/finder/fuzzy"
import { resolveTypedChar } from "@/ui/text-entry"

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
  const { configStore } = useServices()

  /* Vim mode drives the cursor inside the currently loaded rows. */
  const vim = useVimMode(explorer.table.sortedRows.length)
  const vimMode = vim.mode

  /* The cell editor targets one cell: the vim cursor's row and a column cursor
     (right/left arrows), with the draft validated against the schema. */
  const [editColumn, setEditColumn] = useState(0)
  const editor = useCellEditor()

  /* Whole-row editing runs in the user's `$EDITOR` over a `column: value` temp
     file, so nothing in the app can swallow a keystroke or drop an edit. Guard
     against re-entering while a session is still open. */
  const renderer = useRenderer()
  const editorBusyRef = useRef(false)

  /* Fill the data pane: the table is virtualized, so showing as many rows as
     the terminal affords (minus the status bar and table strip) makes the two
     panes read the same height, as in a GUI client. */
  const { height, width } = useTerminalDimensions()
  const viewportRows = Math.max(1, height - 2)
  /* The area the grid gets for its columns: terminal width less the app page
     padding, the 28-wide sidebar, the leading cursor glyph, and row padding. */
  const dataWidth = Math.max(0, width - 2 - 26 - 3)

  /* Never leave the keyboard claimed if the screen goes away mid-edit. */
  useEffect(() => releaseText, [])

  /* `/` search: a ref-backed buffer so a whole chord can be typed and entered
     inside one frame without dropping keys (mirrors the command line). */
  const searchOpenRef = useRef(false)
  const searchBuffer = useRef("")
  const [, bumpSearch] = useState(0)

  /* Search, the finder, and the cell editor are all text surfaces, so each one
     claims the keyboard while open: `:` and `?` are otherwise app-level
     shortcuts, and both are ordinary characters in a search or a cell value.
     Claims are taken on open and released on close (rather than in an effect)
     because the open/close state lives in refs, not render state. */
  const textInput = useTextInput()

  /* INSERT mode: the finder, `/` search, and the cell editor each own the
     keyboard while open. The app dispatcher routes every key to the registered
     owner and never reaches a NORMAL binding, so a filter or a cell value can
     contain `:` `?` `/` `j` `k` — anything. */
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

    if (editor.isEditing()) {
      if (key === "return" || key === "enter" || key === "\r") {
        commitEdit()
        return true
      }
      if (key === "\u001b" || key === "Escape" || key === "escape" || (e.ctrl === true && key === "c")) {
        editor.cancel()
        return true
      }
      if (key === "backspace") {
        editor.backspace()
        return true
      }
      const char = resolveTypedChar(e)
      if (char !== null) editor.type(char)
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

  const openFinder = (cause?: RoutedKey) => {
    finderOpenRef.current = true
    claimText(cause)
    setFinderOpen(true)
    finderQueryRef.current = ""
    setFinderQuery("")
    setFinderCursor(0)
    setFinderEntries([])
    void buildFinderIndex(configStore, active ? active.database : null, explorer.tables)
      .then(entries => setFinderEntries(entries))
      .catch(() => setFinderEntries([]))
  }
  const closeFinder = () => {
    finderOpenRef.current = false
    releaseText()
    setFinderOpen(false)
    finderQueryRef.current = ""
    setFinderQuery("")
    setFinderCursor(0)
    setFinderEntries([])
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
        b.score - a.score ||
        rank[b.entry.kind] - rank[a.entry.kind] ||
        a.entry.label.localeCompare(b.entry.label)
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
      if (entry.projectId && entry.connectionId) explorer.jumpToConnection(entry.projectId, entry.connectionId)
      else toasts.push("info", `database "${entry.label}" has no connection — add one from settings`)
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
      if (explorer.tableName) explorer.openTable(explorer.tableName)
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
    releaseText()
    void explorer.saveCell(target.rowIndex, target.column, result.value)
  }

  const editCurrentRow = () => {
    if (!tableName || !active) {
      toasts.push("error", "no table open to edit")
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
    if (editorBusyRef.current) return
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

  const hints = useMemo(
    () =>
      focus === "sidebar"
        ? ["s settings", "j/k move", "Enter open", "space jump", "h/l panels", "Tab next conn", "? help"]
        : explorer.search.trim()
          ? [`${explorer.searchCount} matches`, "n/N jump", "Esc clear"]
          : ["s settings", "i edit row", "Enter cell", "j/k move", "space jump", "gg/G jump", "/ search", "h/l panels", "? help"],
    [focus, explorer.search, explorer.searchCount]
  )

  /* Push the story to the shell's status bar. The database is the connection:
     one name, its engine alongside. */
  const { setStatus } = session
  useEffect(() => {
    setStatus({
      /* Finder, `/` search, and the cell editor are text fields: while one is
         open the session is in INSERT mode regardless of the vim mode behind
         it. */
      mode: textInput.active ? "insert" : vimMode,
      engine: active?.database.engine,
      database: active?.database.name,
      table: tableName ?? undefined,
      rows: explorer.table.sortedRows.length,
      total: explorer.total ?? undefined,
      hints,
    })
  }, [setStatus, vimMode, active, tableName, explorer.table.sortedRows.length, explorer.total, hints])

  useKeyboard(e => {
    /* NORMAL mode only. `route` hands the key to the INSERT-mode owner when
       one exists (finder, `/` search, cell editor) and says so; there is
       nothing to bind in that case. */
    if (textInput.route(e)) return
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
        case " ":
        case "space":
          openFinder()
          return
        case "s":
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
        explorer.selectActive()
        return
      }
      if (key === "l" || key === "right") {
        setFocus("table")
        return
      }
    } else {
      if (key === " " || key === "space") {
        openFinder(e)
        return
      }
      if (key === "h" || key === "left") {
        setFocus("sidebar")
        return
      }
      if (key === "s") {
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
      if (key === "v") {
        toasts.push("info", "visual mode lands in a later phase")
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
      /* n/N hop between matches inside an active filter (the row window only
         holds matches, so this is next-match / previous-match). */
      if (key === "n" || key === "N") {
        if (explorer.search.trim()) vim.pressKey(key === "n" ? "j" : "k")
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
            claimText(e)
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
        {searchOpenRef.current ? <SearchBar query={searchBuffer.current} matches={explorer.searchCount} /> : null}
        {error ? (
          <box flexGrow={1} alignItems="center" justifyContent="center">
            <text fg={c.error}>{error}</text>
          </box>
        ) : loading ? (
          <box flexGrow={1} alignItems="center" justifyContent="center">
            <text fg={c.textMuted}>connecting…</text>
          </box>
        ) : active ? (
          <DataTable
            table={{ ...explorer.table, cursor: vim.cursor }}
            viewportRows={viewportRows}
            availableWidth={dataWidth}
            empty="no rows"
            editing={editor.preview}
            activeColumn={explorer.table.columns[editColumn]?.name ?? explorer.table.columns[0]?.name}
            highlight={explorer.search.trim() || undefined}
          />
        ) : (
          <box flexGrow={1} alignItems="center" justifyContent="center">
            <text fg={c.textMuted}>select a connection in the sidebar to start browsing</text>
          </box>
        )}
      </box>
      {finderOpen ? <FinderOverlay query={finderQuery} entries={finderMatches} cursor={finderCursor} /> : null}
    </box>
  )
}

function SearchBar({ query, matches }: { query: string; matches: number }) {
  const theme = useTheme()
  const c = theme.colors
  return (
    <box
      height={1}
      paddingX={1}
      flexDirection="row"
      alignItems="center"
      overflow="hidden"
    >
      <text fg={c.accent}>/</text>
      <text fg={c.textBright}>{query}</text>
      <text fg={c.accent}>▍</text>
      <box flexGrow={1} />
      <text fg={c.textMuted}>{matches} matches</text>
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
  const scrollRef = useRef<ScrollBoxRenderable | null>(null)

  /* Keep the active tab reachable: pan the strip sideways so the focused table
     stays visible even when the connection has dozens of tables. */
  useEffect(() => {
    if (tableName) scrollRef.current?.scrollChildIntoView(`dient-tab-${tableName}`)
  }, [tableName])

  if (tables.length === 0 && !loading) {
    return (
      <box height={1} paddingX={1}>
        <text fg={c.textMuted}>{loading ? "loading tables…" : "no tables"}</text>
      </box>
    )
  }

  return (
    <scrollbox ref={scrollRef} scrollX scrollY={false} height={1} horizontalScrollbarOptions={{ showArrows: false }}>
      <box height={1} paddingX={1} flexDirection="row">
        {tables.map(name => {
          const current = name === tableName
          return (
            <box key={name} id={current ? `dient-tab-${name}` : undefined} marginRight={1}>
              <text fg={current ? c.accent : focus ? c.text : c.textMuted} truncate>
                {current ? "▶ " : ""}
                {name.toUpperCase()}
              </text>
            </box>
          )
        })}
      </box>
    </scrollbox>
  )
}
