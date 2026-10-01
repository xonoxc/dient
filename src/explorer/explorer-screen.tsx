/**
 * Explorer screen — the main browsing surface. Left is the project tree
 * (`Sidebar`), right is the data of whichever table is open. Owns the Vim-mode
 * state for table navigation and feeds the shell's status bar through
 * `SessionProvider`.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { Option } from "effect"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useTheme } from "@/theme-context"
import {
  useRouter,
  useCommandLine,
  useSessionStatus,
  useToasts,
  useServices,
  useTextInput,
  type RoutedKey,
} from "@/app-context"
import { Sidebar } from "@/sidebar/sidebar"
import { SIDEBAR_WIDTH } from "@/sidebar/fit-label"
import { DataTable } from "@/table/data-table"
import { selectionRange, useVimMode } from "@/vim"
import { useExplorer } from "@/explorer/use-explorer"
import { useCellEditor } from "@/editor/use-cell-editor"
import { editRowInEditor } from "@/editor/edit-row-in-editor"
import { yankRows } from "@/editor/row-clipboard"
import { writeSystemClipboard } from "@/ui/clipboard"
import { formatCell } from "@/table/use-table"
import { useCommand } from "@/app-context"
import { buildFinderIndex, type FinderEntry } from "@/finder/finder"
import { FinderOverlay } from "@/finder/finder-overlay"
import { fuzzyMatch } from "@/finder/fuzzy"
import { normalModeKey, resolveTypedChar } from "@/ui/text-entry"
import { windowTail } from "@/ui/text-window"
import { LoadingIndicator } from "@/ui/loading-indicator"

const TABLE_MOVE_KEYS = new Set(["j", "k", "g", "G"])

export function ExplorerScreen() {
  const theme = useTheme()
  const c = theme.colors
  const router = useRouter()
  const commandLine = useCommandLine()
  const session = useSessionStatus()
  const toasts = useToasts()
  const explorer = useExplorer()
  const { sidebar, focus, setFocus, active, loading, error, tableName, tableInfo } = explorer
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
     padding, the sidebar, the leading cursor glyph, and row padding.
     The sidebar width is read from the sidebar rather than repeated here — the
     literal was stale (it said 26 while the sidebar is 32), and every cell of
     the difference became permanent horizontal overflow: the rightmost column
     was always cut off and a scrollbar was always on screen. */
  const dataWidth = Math.max(0, width - 2 - SIDEBAR_WIDTH - 3)

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
    void buildFinderIndex(configStore, active ? active.database : null, explorer.tables)
      .then(entries => {
        if (finderRequest.current === request) setFinderEntries(entries)
      })
      .catch(() => {
        if (finderRequest.current === request) setFinderEntries([])
      })
      .finally(() => {
        if (finderRequest.current === request) setFinderLoading(false)
      })
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
    const columns = tableInfo?.columns ?? []
    const yank = yankRows(columns, explorer.table.sortedRows, vim.cursor, vim.selection)
    if (!yank) {
      toasts.push(
        "error",
        columns.length > 0 ? "no rows to copy" : `table ${tableName} has no columns to copy`
      )
      return
    }
    const { text, count } = yank
    void writeSystemClipboard(text, renderer).then(result => {
      if (result.ok) {
        toasts.push("info", `copied ${count} row${count === 1 ? "" : "s"} to the clipboard`)
      } else {
        toasts.push("error", "could not write to the clipboard")
      }
    })
  }

  const hints = useMemo(() => {
    /* While a selection is open those are the only live keys, so the hints name
       them and nothing else — the normal bindings are inert until it closes. */
    if (vimMode === "visual")
      return ["y copy", "j/k extend", "gg/G ends", "Esc cancel"]

    /* Paging leads the hint list. Hints get a third of the strip, so one buried
       at the end of ten others is never seen — and paging is the one action a
       user cannot discover from the data on screen. */
    const paging: string[] = []
    if (explorer.hasNextPage) paging.push("^f next page")
    if (explorer.hasPrevPage) paging.push("^b prev page")

    if (focus === "sidebar") {
      return [...paging, "s settings", "j/k move", "Enter open", "space jump", "h/l panels", "q quit", "? help"]
    }
    if (explorer.search.trim()) return [...paging, `${explorer.searchCount} matches`, "n/N jump", "Esc clear"]
    return [
      ...paging,
      "s settings",
      "i edit row",
      "V select rows",
      "Enter cell",
      "j/k move",
      "space jump",
      "gg/G jump",
      "/ search",
      "h/l panels",
      "q quit",
      "? help",
    ]
  }, [focus, explorer.search, explorer.searchCount, explorer.hasNextPage, explorer.hasPrevPage, vimMode])

  /* The open visual-mode span, normalized, for both the highlighted band and
     the status count. Recomputed from the cursor's selection on every render,
     so it can never drift from the row window it indexes. */
  const selection = Option.getOrNull(vim.selection)
  const selectedRange = selection ? selectionRange(selection) : null
  const selectedCount = selectedRange ? selectedRange.end - selectedRange.start + 1 : undefined

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
       one exists (finder, `/` search, cell editor) and says so; there is
       nothing to bind in that case. */
    if (textInput.route(e)) return
    if (router.helpOpen || commandLine.open) return
    const key = normalModeKey(e)

    /* `q` quits, but only from NORMAL with nothing modal open — the guards
       above already returned for a text field, the help overlay, and the
       command line. Without a VISUAL check `q` would quit out from under an
       open selection, so it is refused there and the selection keeps it. */
    if (key === "q" && vimMode !== "visual") {
      router.exit(0)
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
      /* VISUAL mode owns the keyboard: movement extends the linewise selection,
         `y` yanks it and closes, and every other key is swallowed rather than
         acting on one row while a span is highlighted. */
      if (vimMode === "visual") {
        if (key === "y" || key === "Y") {
          copyRows()
          vim.pressKey("escape")
          return
        }
        if (key === "v" || key === "V" || key === "\u001b" || key === "Escape" || key === "escape") {
          vim.pressKey("escape")
          return
        }
        if (TABLE_MOVE_KEYS.has(key) || key === "up" || key === "down") {
          vim.pressKey(key === "up" ? "k" : key === "down" ? "j" : key)
        }
        return
      }
      if (key === " " || key === "space") {
        openFinder(e)
        return
      }
      if (key === "h") {
        setFocus("sidebar")
        return
      }
      if (key === "l") {
        setFocus("table")
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
      if (key === "\u001b" || key === "Escape" || key === "escape") {
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
        <TableStrip
          tableName={tableName}
          loading={loading}
          focus={focus === "table"}
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
        {error ? (
          <box flexGrow={1} alignItems="center" justifyContent="center">
            <text fg={c.error}>{error}</text>
          </box>
        ) : loading ? (
          <box flexGrow={1} alignItems="center" justifyContent="center">
            <LoadingIndicator label={tableName ? `loading ${tableName}…` : "connecting…"} />
          </box>
        ) : active ? (
          <DataTable
            table={{ ...explorer.table, cursor: vim.cursor }}
            viewportRows={viewportRows}
            availableWidth={dataWidth}
            empty="no rows"
            editing={editor.preview}
            activeColumn={explorer.table.columns[editColumn]?.name ?? explorer.table.columns[0]?.name}
            columnFocus={focus === "table"}
            highlight={explorer.search.trim() || undefined}
            selection={selectedRange}
          />
        ) : (
          <box flexGrow={1} alignItems="center" justifyContent="center">
            <text fg={c.textMuted}>select a connection in the sidebar to start browsing</text>
          </box>
        )}
      </box>
      {finderOpen ? (
        <FinderOverlay query={finderQuery} entries={finderMatches} cursor={finderCursor} loading={finderLoading} />
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
  loading,
  focus,
  compact,
  offset,
  rows,
  total,
  pageSize,
  hasPrevPage,
  hasNextPage,
}: {
  tableName: string | null
  loading: boolean
  focus: boolean
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
        <text fg={c.textMuted}>{loading ? "connecting" : "no table open"}</text>
      </box>
    )
  }

  return (
    <box height={1} flexDirection="row" overflow="hidden">
      <box height={1} paddingX={1} backgroundColor={c.bgHighlight}>
        <text fg={focus ? c.accent : c.textBright} truncate>
          {"\u258c " + tableName.toUpperCase()}
        </text>
      </box>
      <box flexGrow={1} />
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
