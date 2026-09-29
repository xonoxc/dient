# dient

<p align="center">
  <strong>A terminal database client for MySQL, PostgreSQL and SQLite — with Vim-style keys.</strong>
</p>

<p align="center">
  <a href="https://bun.sh"><img alt="Bun 1.3.0 or later" src="https://img.shields.io/badge/bun-%3E%3D1.3.0-111111?style=flat-square"></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript strict" src="https://img.shields.io/badge/typescript-strict-3178C6?style=flat-square"></a>
  <img alt="OpenTUI renderer" src="https://img.shields.io/badge/renderer-opentui-8A8A8A?style=flat-square">
</p>

---

A project is a **group of databases**; a database carries exactly one connection
and its tables. The sidebar is that tree, the grid is the table, and the keyboard
never leaves them.

```text
┌ PROJECTS ────────────────┐┌ ORDERS ────────────────────────────────────┐
│ ▾ demo                   ││ ID ITEM QTY TOTAL                          │
│   ▾ ▶ ● sample  SQLite   ││   1 widget      3     9.99                 │
│     ▸ orders             ││   2 gadget      1    24.50                 │
│     ▸ users              ││   3 gizmo       7    11.00                 │
└──────────────────────────┘└────────────────────────────────────────────┘
   NORMAL  dient  sample · sqlite · orders  3 rows
```

<sub>Schematic. <code>▾</code>/<code>▸</code> expand a node, <code>▶</code> marks the
active connection, <code>●</code> is connection status.</sub>

### What it does

- **Fuzzy finder** — `Space` searches every project, database and table at once;
  jumping to a database expands and connects it in a single keystroke.
- **In-place editing** — `Enter` edits the cell under the cursor, with the value
  typed against the column's SQL type.
- **`$EDITOR` round-trip** — `i` writes the current row to a temp file as
  `column: value` pairs and reads the edits back on save.
- **Linewise yank** — `V` then `j`/`k` then `y` copies whole rows to the system
  clipboard, one block per row, comments stripped.
- **Pager, filter, search** — `Ctrl+f`/`Ctrl+b` page 200 rows at a time, `/`
  filters the page, `n`/`N` walk the matches.
- **Connection management** — projects, databases and connections, with a live
  "test connection" probe and a confirmation before any delete.

---

## Requirements

- **[Bun](https://bun.sh/) 1.3.0+** — runtime, package manager and test runner.
- **A terminal OpenTUI can drive.** The highlight bands want truecolor. The
  finder, settings and help panels size themselves against the terminal width;
  the confirm dialog is a fixed 60 columns.

## Getting started

```bash
bun install
bun dev            # run from source, with --watch
```

Or compile a standalone binary and run that instead:

```bash
bun run build      # → ./dient
./dient
```

Then, in the app:

1. `s` opens **settings**.
2. `a` adds a database — or `p` pastes a connection URI:

   ```text
   postgres://user:pass@host:5432/database
   mysql://user:pass@host:3306/database
   sqlite:///absolute/path/to/file.db
   ```

   The parser is deliberately permissive: `postgresql://` and `file://` also
   work, and a bare path is taken as SQLite.
3. `t` tests the connection, `Enter` saves, `e` returns to the explorer.
4. `Enter` on a database connects and opens its first table.

## Scripts

| Command | What it does |
| --- | --- |
| `bun dev` | Run from source with `--watch` |
| `bun run typecheck` | `tsc --noEmit` |
| `bun test` | Unit and TUI integration tests |
| `bun run format` | `prettier --write .` |
| `bun run build` | Compile a standalone binary to `./dient` |

---

## Keybindings

`?` opens this reference in-app. The tables below mirror
`src/ui/help-screen.tsx` — change both together.

### Explorer

| Key | Action |
| --- | --- |
| `j` / `k` (↓ / ↑) | Move down / up |
| `gg` / `G` | First / last |
| `h` / `l` | Focus sidebar / table |
| ← / → | Previous / next column |
| `Enter` | Open a table, or edit the cell under the cursor |
| `i` | Edit the current row in `$EDITOR` |
| `V` | Start a row selection |
| `y` | Copy the selection to the clipboard |
| `/` | Filter the current page |
| `n` / `N` | Next / previous match |
| `Ctrl+f` / `Ctrl+b` | Next / previous page |
| `Tab` | Next connection |
| `Space` | Open the quick finder |
| `s` | Settings |

### Settings

| Key | Action |
| --- | --- |
| `j` / `k` (↓ / ↑), `gg` / `G` | Move, first / last |
| `Enter` | Expand / select |
| `a` | Add a database |
| `p` | Paste a connection URI |
| `Shift+P` | Add a project |
| `r` / `t` / `d` | Rename / test connection / delete |
| `e` | Back to the explorer |

### Commands

Type `:` for the command line.

| Command | Action |
| --- | --- |
| `:e <table>` | Open a table |
| `:connect <name>` | Switch database |
| `:refresh` | Reload the current table |
| `:settings` / `:explorer` | Switch screen |
| `:help` | Keybindings |
| `:q` | Quit (from settings, back to the explorer) |
| `:w` | No-op — cell and row edits are written as you save them |

---

## State on disk

| Path | Contents |
| --- | --- |
| `~/.dient/config.db` | Projects, databases, connections. A SQLite file, migrated in place on open. |
| `~/.dient/error.log` | One line per unexpected failure, tail-capped at 2000 lines. Logging never blocks or crashes the UI. |

### A note on the clipboard

A copy goes to the **host clipboard** (so it works over SSH into a local display)
and is mirrored over **OSC 52** when the terminal advertises support. The host
writer is kept alive for the life of the process, because a Wayland/X11 clipboard
is an *offer to own the selection*, not a stored value — dispose the writer and
every copy reports success while pasting nothing. OSC 52 is what makes a copy
survive quitting dient.

---

## Architecture

```text
src/
├── index.tsx        boot: renderer, theme, services, render <App>
├── runtime.ts       the Layer.provide graph — the service boundary
├── effect/run.ts    runService: the one place a service Effect becomes a Promise
│
├── config/          ConfigStore       SQLite-backed, tagged ConfigError
├── drivers/         DatabaseDriver    Postgres / MySQL / SQLite behind one port
├── connection/      ConnectionManager connect, query, status, retry-with-backoff
├── inspector/       SchemaInspector   listTables, describeTable
├── query/           QueryExecutor     parameter binding, identifier quoting
│
├── sidebar/         the project → database → table tree
├── explorer/        ExplorerScreen    connect, paging, cell and row saves
├── table/           the data grid
├── finder/          the Space-bar fuzzy finder
├── settings/        connection management
│
├── editor/          $EDITOR round-trip, row serialization, clipboard payloads
├── ui/              clipboard, toasts, modals, text entry and windowing
├── vim/             motions and linewise visual mode
├── theme.ts         palette, light/dark detection
└── errors/          turning any throwable into one readable line
```

**The split that matters:** `config/` through `query/` is the service layer —
pure Effect, typed failures, no React. Everything from `sidebar/` down is the
React surface that drives it fire-and-forget.

## Conventions

These are rules the codebase already follows, not aspirations.

- **Effect owns the service layer.** Every method on `ConfigStore`,
  `DatabaseDriver`, `ConnectionManager`, `SchemaInspector` and `QueryExecutor`
  returns an `Effect`, built as a full `Effect.gen` pipeline. Dependencies are
  wired explicitly with `Layer.provide` in `src/runtime.ts`, so the assembled
  graph needs nothing from the environment.
- **Failures are typed, never thrown.** Use `Data.TaggedError` and
  `Effect.mapError` — see `ConfigError`, `ConnectionError`, `QueryError`.
  `onError` in `src/config/config-store.ts` is the reference: fold every
  underlying error into one tagged error while preserving `cause`.
- **Cross the boundary with `runService`, never `Effect.runPromise`.**
  `Effect.runPromise` rejects with a `FiberFailure`, which carries only `name`
  and `stack` — the real `ConnectionError`, and through it `ECONNREFUSED`, is
  unreachable from it. `runService` converts to `Either` first so the rejection
  carries the typed error. Use it wherever a service Effect is awaited inside a
  `.catch` that shows a message.
- **React is the frame loop, Effect the service boundary.** Hooks run every
  effect fire-and-forget and never block a render. They hold mutable truth in
  refs, so a chord pressed within one frame (`j` then `Enter`) acts on the *live*
  cursor and item list rather than the previous render's snapshot. Prefer
  `Option` over nullable sentinels, and a stale-request counter over stale async
  results.
- **Never interpolate a name into SQL.** Pass table and column names through
  `cleanIdentifier` (`src/query/identifier.ts`) and bind every value.
- **Sync-only stays sync.** `src/fs/path-complete.ts` runs inside `useMemo`; it
  is not a gap waiting to be effectified.
- **Tests.** `bun test`. TUI integration tests render through
  `test/support/render-ui.ts` (`renderApp`, `pressKeys`, `waitForFrame`). Note
  that one `pressKeys` batch reaches the handler with pre-batch state, so split
  dispatches when a key changes focus.

---

<p align="center">
  <em>Scaffolded with <code>bun create tui</code> —
  <a href="https://github.com/msmps/create-tui">create-tui</a> is the easiest way to start a
  new OpenTUI project.</em>
</p>
