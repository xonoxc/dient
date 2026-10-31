# dient

<p align="center">
  <strong>A terminal database client for MySQL, PostgreSQL, SQLite and Redis — with Vim-style keys.</strong>
</p>

<p align="center">
  <a href="https://bun.sh"><img alt="Bun 1.3.0 or later" src="https://img.shields.io/badge/bun-%3E%3D1.3.0-111111?style=flat-square"></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript strict" src="https://img.shields.io/badge/typescript-strict-3178C6?style=flat-square"></a>
  <img alt="OpenTUI renderer" src="https://img.shields.io/badge/renderer-opentui-8A8A8A?style=flat-square">
</p>

---

A project is a **group of databases**; a database carries exactly one connection
and its tables (or keyspace, for Redis). The sidebar is that tree, the grid is
the table, and the keyboard never leaves them.

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
- **In-place inspection** — `Enter` previews the row under the cursor; `e`
  expands a truncated cell without leaving the table.
- **`$EDITOR` round-trip** — `i` writes the current row to a temp file as
  `column: value` pairs and reads the edits back on save.
- **Linewise yank** — `V` then `j`/`k` then `y` copies whole rows to the system
  clipboard, one block per row, comments stripped.
- **Pager, filter, search** — `Ctrl+f`/`Ctrl+b` page 200 rows at a time, `/`
  filters the page, `n`/`N` walk the matches.
- **Connection management** — projects, databases and connections, with a live
  "test connection" probe and a confirmation before any delete.
- **Redis browsing and editing** — `SCAN`-based keyspace, type-aware key views:
  strings and RedisJSON as wrapped text, hashes/lists/sets/sorted sets as
  tables, and streams as timestamped cards. `i` renames keys, edits string and
  JSON values, and edits collection fields/members/scores.

---

## Requirements

- **[Bun](https://bun.sh/) 1.3.0+** — runtime, package manager and test runner.
- **A terminal OpenTUI can drive.** The highlight bands want truecolor. The
  finder, settings and help panels size themselves against the terminal width;
  the confirm dialog is a fixed 60 columns.
- **Docker + Compose (optional)** — only needed to run the sample PostgreSQL,
  MySQL, Redis and RabbitMQ stack described below.

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
   redis://user:pass@host:6379/0
   rediss://user:pass@host:6380/0       # TLS
   ```

   The parser is deliberately permissive: `postgresql://`, `valkey://`,
   `valkeys://` and `file://` also work, and a bare path is taken as SQLite.
   The Redis path is a numeric database index, not a database name.

   Every URI pauses on an optional name. The suggested value is the URL tail
   (`…/shop` → `shop`), the SQLite file stem, or `host:port/index` for Redis;
   press `Enter` to keep it or type a new name. In the field form the name is
   also optional and falls back to the database/file stem or `host:port`.
3. `t` tests the connection, `Enter` saves, `e` returns to the explorer.
   On a database row, `r` renames the display name.
4. `Enter` on a database connects and opens its first table.

## Sample Docker stack

A ready-to-browse stack lives in [`docker-compose.yml`](docker-compose.yml). It
starts PostgreSQL, MySQL, Redis Stack (with RedisJSON) and RabbitMQ (with the
management plugin), and seeds them with multiple databases, representative
rows/keys, and a sample message topology.

```bash
docker compose up -d
docker compose logs -f redis-seed rabbitmq-seed   # Ctrl-C after both finish
```

| Connection | URL |
| --- | --- |
| PostgreSQL · `dient` | `postgres://dient:dient@localhost:55432/dient` |
| PostgreSQL · `analytics` | `postgres://dient:dient@localhost:55432/analytics` |
| MySQL · `shop` | `mysql://dient:dient@localhost:53306/shop` |
| MySQL · `game_service` | `mysql://dient:dient@localhost:53306/game_service` |
| Redis · DB 0 | `redis://localhost:56379/0` |
| Redis · DB 1 | `redis://localhost:56379/1` |
| RabbitMQ · vhost `/` | `rabbitmq://dient:dient@localhost:55672/` |

The PostgreSQL databases contain users, products, orders, and 250 JSON events
for paging. MySQL contains a shop schema and a `game_service` schema with 250
runs. Redis DB 0 has strings (including a 70 KB value for the truncation
notice), a hash, list, set, sorted set, stream, TTL key, and a RedisJSON
document; DB 1 has a separate greeting to exercise the `/1` database suffix.

RabbitMQ exposes the management API on `55672` and AMQP on `55673`; dient uses
the management API, so connect with a `rabbitmq://` URL. The sample broker has a
durable `dient.events` topic exchange bound to `dient.orders` (`orders.*`) and
`dient.notifications` (`notifications.#`, a quorum queue), with JSON and
plain-text messages ready to peek and republish.

The seed is idempotent, so `docker compose up -d` after a normal `docker compose
down` keeps your changes; the RabbitMQ seeder only fills a sample queue when it
is empty, so reruns do not duplicate messages. To wipe the volumes and reseed
everything:

```bash
docker compose down -v
docker compose up -d
```

If `55432`, `53306`, `56379`, `55672` or `55673` is already in use, change the
host side of the port mapping in `docker-compose.yml`. SQLite needs no service —
paste an absolute path such as `sqlite:///absolute/path/to/file.db`.

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

Panes are numbered left to right from `1`; pressing a pane's number focuses it.
The rule is the same on every screen with more than one pane.

### Explorer

| Key | Action |
| --- | --- |
| `j` / `k` (↓ / ↑) | Move down / up; scroll a Redis string or stream |
| `gg` / `G` | First / last; top / bottom of a Redis value |
| `1` / `2` | Focus pane 1 (sidebar) / pane 2 (table) |
| `\` | Toggle the sidebar |
| `h` / `l` | Scroll columns left / right |
| ← / → | Previous / next column |
| `Enter` | Open a Redis key, or preview the row |
| `Esc` | Leave an open Redis key for the keyspace |
| `i` | Edit the current row/value in `$EDITOR` (Redis: rename a key in the keyspace) |
| `V` | Start a row selection |
| `y` | Copy the selection to the clipboard |
| `/` | Filter the current page |
| `n` / `N` | Next / previous match |
| `Ctrl+f` / `Ctrl+b` | Next / previous page |
| `Tab` | Next connection |
| `Space` | Open the quick finder |
| `s` | Settings |

### Redis

A Redis connection opens on a `keys` table. `Enter` drills into the key under
the cursor: strings and RedisJSON values open in a wrapped text panel; streams
open as cards of field/value pairs; hashes, lists, sets and sorted sets use the
normal table (with `field/value`, `index/value`, `member`, and
`rank/score/member` columns). Paging uses `SCAN` cursors for keys, hashes and
sets, offsets for lists and sorted sets, and entry IDs for streams.

`i` edits what is under the cursor. In the keyspace it renames the key
(`RENAMENX`, so an existing destination is never clobbered). On a string or
RedisJSON key it opens the whole value in `$EDITOR`; string writes use
`SET … KEEPTTL`, and RedisJSON writes use `JSON.SET`. On a hash, list, set or
sorted set it opens the row as `column: value` fields: hash fields and set/zset
members can be renamed, list values and zset scores can be changed, and the
list `index` / zset `rank` columns are fixed identifiers. Collection commands
preserve TTL naturally. Stream entries are Redis-append-only, so the stream
card view remains a reader; its key can still be renamed from the keyspace.

The driver is standalone (no Cluster/Sentinel) and understands the core Redis
types plus RedisJSON; module-specific types without a dedicated view fall back
to a metadata row.

### Settings

| Key | Action |
| --- | --- |
| `j` / `k` (↓ / ↑), `gg` / `G` | Move, first / last |
| `1` / `2` | Focus pane 1 (workspaces) / pane 2 (details) |
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
| `:upgrade` | Install the pending update |
| `:ignore-update` | Skip the pending update |
| `:version` | Show the app version |
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
│                    RedisDriver       raw Redis commands, Bun's client
├── connection/      ConnectionManager connect, query, status, retry-with-backoff
├── inspector/       SchemaInspector   listTables, describeTable
├── redis/           RedisInspector    SCAN + type-aware key pages and writes
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
  `DatabaseDriver`, `RedisDriver`, `ConnectionManager`, `SchemaInspector`,
  `RedisInspector` and `QueryExecutor` returns an `Effect`, built as a full
  `Effect.gen` pipeline. Dependencies are wired explicitly with `Layer.provide`
  in `src/runtime.ts`, so the assembled graph needs nothing from the
  environment.
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
