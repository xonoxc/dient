/**
 * Explorer screen tests — connection → table-list → table-data flow as
 * rendered by the real App. Covers connecting to a seeded file, Tab switching
 * between two connections (each with its own table set), and an empty database
 * showing its friendly empty states.
 */
import { describe, expect, test } from "bun:test"
import App from "@/app"
import { makeTheme } from "@/theme"
import { Database as SqliteDatabase } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pressKeys, renderApp, waitForFrameDriven } from "@test/support/render-ui"
import { freshConfigFile, freshSqliteDataFile, resolveTestServices, seedProject } from "@test/support/services-fixture"

async function expandToConnection(setup: Awaited<ReturnType<typeof renderApp>>) {
  await pressKeys(setup, ["RETURN"])
  await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("○ main"))
  await pressKeys(setup, ["j", "RETURN"])
  await setup.waitForFrame(f => f.includes("USERS") && f.includes("alice"))
}

/** Two tables, so "one tab" and "a tab per table" are distinguishable. */
function multiTableDb(): string {
  const path = join(mkdtempSync(join(tmpdir(), "dient-multi-")), "multi.db")
  const db = new SqliteDatabase(path)
  db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
  db.run("INSERT INTO users (id, name) VALUES (1, 'alice')")
  db.run("CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT)")
  db.close()
  return path
}

/** Connect without asserting on the top bar, whose content is one table. */
async function expandToConnectionAnyTable(setup: Awaited<ReturnType<typeof renderApp>>) {
  await pressKeys(setup, ["RETURN"])
  await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("○ main"))
  await pressKeys(setup, ["j", "RETURN"])
  await setup.waitForFrame(f => f.includes("●") && f.includes("▸ users"))
}

/** A throwaway sqlite file with a distinct basename (freshSqliteDataFile is always "data.db"). */
function ordersFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), "dient-data-")), "orders.db")
  const db = new SqliteDatabase(path)
  db.run("CREATE TABLE orders (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)")
  db.run("INSERT INTO orders (id, name, email) VALUES (1, 'iphone', 'picked')")
  db.close()
  return path
}

describe("explorer screen", () => {
  test("connecting to a connection loads its tables and opens the first one", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile(),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await expandToConnection(setup)
      const frame = setup.captureCharFrame()
      expect(frame).toContain("▌ USERS")
      expect(frame).toContain("alice")
      expect(frame).toContain("main · sqlite")
    } finally {
      setup.renderer.destroy()
    }
  })

  /* `V` opens a linewise row selection (the table's line is a row); `j`/`k`
     extend it and `y` copies every row it spans. The count in the confirmation
     is the user's own selection, so this pins both the span and the yank. */
  test("V selects rows, j extends, y copies the selection to the clipboard", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile(),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await expandToConnection(setup)
      /* Focus must land on the table before the selection keys are read, so this
         is two dispatches: the handler in one batch still sees the old focus. */
      await pressKeys(setup, ["l"])
      await pressKeys(setup, ["SHIFT+v"])
      await setup.waitForFrame(f => f.includes("VISUAL"))

      /* Two more rows join the anchor, and the status counts them live. */
      await pressKeys(setup, ["j", "j"])
      await setup.waitForFrame(f => f.includes("3 selected"))

      await pressKeys(setup, ["y"])
      /* The clipboard write resolves after the keypress, off the frame loop, so
         the toast needs frames driven to arrive — same as an $EDITOR resume. It
         names the selection on success, or reports the host failure on a
         machine with no clipboard; either way the yank path ran. The exact
         payload and the writer's lifetime are asserted in the clipboard tests. */
      const frame = await waitForFrameDriven(setup, f => f.includes("clipboard"))
      expect(frame).toMatch(/copied 3 rows to the clipboard|could not write to the clipboard/)
      /* Yanking closes the selection, back in NORMAL. */
      await setup.waitForFrame(f => f.includes("NORMAL"))
    } finally {
      setup.renderer.destroy()
    }
  })

  /* The payload the `y` above hands the clipboard is asserted here rather than
     in the unit serializer, because the unit cannot see the keys: what matters
     is that the shortcut and the selection reach the writer and what arrives is
     a padded Markdown table. `copyToClipboardOSC52` is the writer's last
     hop and is stubbed to capture the text, which also makes the toast
     deterministic on a machine with no clipboard. */
  test("y puts an aligned Markdown table on the clipboard for the whole selection", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile(),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    const copied: string[] = []
    Object.defineProperty(setup.renderer, "copyToClipboardOSC52", {
      value: (text: string) => {
        copied.push(text)
        return true
      },
      configurable: true,
      writable: true,
    })
    try {
      await expandToConnection(setup)
      /* Focus must land on the table before the selection keys are read. */
      await pressKeys(setup, ["l"])
      await pressKeys(setup, ["SHIFT+v"])
      await setup.waitForFrame(f => f.includes("VISUAL"))
      await pressKeys(setup, ["j"])
      await setup.waitForFrame(f => f.includes("2 selected"))

      await pressKeys(setup, ["y"])
      await waitForFrameDriven(setup, f => f.includes("copied 2 rows"))

      expect(copied).toHaveLength(1)
      expect(copied[0]).toBe(
        "| id   | name  | email             |\n" +
          "| ---- | ----- | ----------------- |\n" +
          "| 1    | alice | alice@example.com |\n" +
          "| 2    | bob   | bob@example.com   |\n"
      )
    } finally {
      setup.renderer.destroy()
    }
  })

  /* The top bar is a single tab for the open table, not a strip of every table
     in the database. A wide schema used to put a hundred tabs in a one-line
     scroller, and because each tab was its own margin-carrying box the layout
     engine offset every one of them by a column, fusing neighbours into
     "PROVIDERRESTRICTEDCOUNTRY". The full list lives in the sidebar. */
  test("the top bar shows only the open table, not every table", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: multiTableDb(),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await expandToConnectionAnyTable(setup)
      const frame = setup.captureCharFrame()
      /* The open table is the single tab. */
      expect(frame).toMatch(/▌ (USERS|ORDERS)/)
      /* Every other table is reachable in the sidebar, not the top bar. */
      expect(frame).toContain("▸ users")
      expect(frame).toContain("▸ orders")
      /* Exactly one tab marker, so nothing is laid out side by side. */
      expect(frame.split("▌").length - 1).toBe(1)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("Tab cycles databases and refreshes table list, data, and status", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile(),
    })
    await seedProject(services.store, {
      name: "beta",
      database: "app",
      engine: "sqlite",
      filename: ordersFile(),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      /* projects render name-sorted, so beta is the first row: expand it, then
         connect the app database */
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ beta") && f.includes("○ app"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("▌ ORDERS") && f.includes("iphone"))
      const beta = setup.captureCharFrame()
      expect(beta).toContain("app · sqlite")
      expect(beta).not.toContain("alice")

      /* cursor sits on the app row, which now lists its table beneath it; two
         downs skip the table row and land on the demo project to expand */
      await pressKeys(setup, ["j", "j", "RETURN"])
      await setup.waitForFrame(f => f.includes("○ main"))
      await pressKeys(setup, ["j"])

      /* Tab wraps around to the first connection: main connects and its data
         lands in the strip (it is not the active connection, yet) */
      await pressKeys(setup, ["TAB"])
      await setup.waitForFrame(f => f.includes("▌ USERS") && f.includes("alice"))
      const back = setup.captureCharFrame()
      expect(back).toContain("main · sqlite")
      expect(back).not.toContain("iphone")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("a connection backed by an empty database shows empty states, not a crash", async () => {
    const empty = join(mkdtempSync(join(tmpdir(), "dient-empty-")), "data.db")
    new SqliteDatabase(empty).close()
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: empty })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("○ main"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("no table open") && f.includes("no rows"))
      const frame = setup.captureCharFrame()
      expect(frame).toContain("no table open")
      expect(frame).toContain("no rows")
    } finally {
      setup.renderer.destroy()
    }
  })
})

describe("row paging", () => {
  /** A table with more rows than one page, so paging is observable. */
  function pagedDb(rows: number): string {
    const path = join(mkdtempSync(join(tmpdir(), "dient-page-")), "paged.db")
    const db = new SqliteDatabase(path)
    db.run("CREATE TABLE games (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
    for (let i = 1; i <= rows; i++) db.run("INSERT INTO games (id, name) VALUES (?, ?)", [i, `game-${i}`])
    db.close()
    return path
  }

  async function openPaged(rows: number) {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: pagedDb(rows) })
    const rendered = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    await pressKeys(rendered, ["RETURN"])
    await rendered.waitForFrame(f => f.includes("▾ demo") && f.includes("○ main"))
    await pressKeys(rendered, ["j", "RETURN"])
    await rendered.waitForFrame(f => f.includes("▌ GAMES"))
    return rendered
  }

  /* Rows are paged in the database with LIMIT/OFFSET, not sliced in the view.
     Opening a table used to hardcode `offset: 0` with no way to change it, so
     only the first 200 rows of a larger table were reachable at all. */
  test("Ctrl+f / Ctrl+b walk the whole table one page at a time", async () => {
    const setup = await openPaged(450)
    try {
      expect(setup.captureCharFrame()).toContain("1-200 of 450")

      await pressKeys(setup, ["l"])
      await pressKeys(setup, ["CTRL+f"])
      await setup.waitForFrame(f => f.includes("201-400 of 450"))

      await pressKeys(setup, ["CTRL+f"])
      await setup.waitForFrame(f => f.includes("401-450 of 450"))

      /* The last page is short; paging past it is a no-op, not an empty screen. */
      await pressKeys(setup, ["CTRL+f"])
      expect(setup.captureCharFrame()).toContain("401-450 of 450")

      await pressKeys(setup, ["CTRL+b"])
      await setup.waitForFrame(f => f.includes("201-400 of 450"))
    } finally {
      setup.renderer.destroy()
    }
  })

  /* Paging used to read the offset from render state, so two Ctrl+f presses
     inside one render both resolved to page 2 and the second press looked like
     it did nothing. A held-down Ctrl+f stalled at page 2 entirely. */
  test("page turns sent in one batch do not collapse onto the same page", async () => {
    const setup = await openPaged(900)
    try {
      await pressKeys(setup, ["l"])
      await pressKeys(setup, ["CTRL+f", "CTRL+f", "CTRL+f", "CTRL+f"])
      await setup.waitForFrame(f => f.includes("801-900 of 900"))
    } finally {
      setup.renderer.destroy()
    }
  })

  test("a single-page table is not labelled as paged", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile(),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await expandToConnection(setup)
      const frame = setup.captureCharFrame()
      expect(frame).not.toContain("of 1")
      expect(frame).not.toContain("next page")
    } finally {
      setup.renderer.destroy()
    }
  })
})

describe("failed connection dialog", () => {
  /* The real report: `String(cause)` on an Effect rejection produced a
     `FiberFailure` dump whose stack spilled out of the 60-column modal, under
     a title reading `Connection "game_service · game_service" failed`. Both
     halves came from the same mistake — treating a rejection as something to
     print. */
  test("shows one short line that fits the panel, with the name stated once", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "game_service",
      engine: "mysql",
      /* Port 1 is reserved and never listening, so this fails fast and locally.
         Nothing touches a real server. */
      host: "127.0.0.1",
      port: 1,
      user: "root",
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ demo"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("failed"))

      const frame = setup.captureCharFrame()

      /* The title names the target exactly once. */
      expect(frame).toContain('Connection "game_service" failed')
      expect(frame).not.toContain("·")
      /* The actionable reason, not the plumbing above it. */
      expect(frame).toContain("ECONNREFUSED")
      /* None of the rendering artefacts of a raw rejection. */
      expect(frame).not.toContain("FiberFailure")
      expect(frame).not.toContain("[cause]")
      expect(frame).not.toContain("SqlError")
      expect(frame).not.toContain("at <anonymous>")
      /* The body is a single logical line, so nothing can overrun the panel. */
      expect(frame).toContain("retry")

      /* The panel is borderless, so containment is a width check: the body is
         one logical line that fits the 56-column content area and is not
         wrapped onto a second row. */
      const rows = frame.split("\n")
      const bodyRows = rows.filter(row => row.includes("Failed to connect"))
      expect(bodyRows).toHaveLength(1)
      const body = bodyRows[0]!.trim()
      expect(body.startsWith("Failed to connect:")).toBe(true)
      expect(body.length).toBeLessThanOrEqual(56)
    } finally {
      setup.renderer.destroy()
    }
  }, 30000)
})

describe("list navigation", () => {
  /** A short table: every row is on screen, so the cursor marker is visible. */
  function shortDb(): string {
    const path = join(mkdtempSync(join(tmpdir(), "dient-g-")), "short.db")
    const db = new SqliteDatabase(path)
    db.run("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
    for (const name of ["alpha", "bravo", "charlie", "delta", "echo"]) {
      db.run("INSERT INTO items (name) VALUES (?)", [name])
    }
    db.close()
    return path
  }

  const lineWith = (frame: string, value: string): string => frame.split("\n").find(line => line.includes(value)) ?? ""

  /* Terminals report Shift+G as the unshifted base `g` plus the shift flag, so
     a NORMAL binding that reads `e.name` saw `g` and started a `gg`. The key is
     normalized before dispatch, and `G` reaches the table's jump-to-last. */
  test("Shift+G jumps the table cursor to the last row", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: shortDb() })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("○ main"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("▌ ITEMS") && f.includes("echo"))
      await pressKeys(setup, ["l"])

      /* The cursor starts on the first row, not the last. */
      expect(lineWith(setup.captureCharFrame(), "echo")).not.toContain("▶")

      await pressKeys(setup, ["SHIFT+g"])
      expect(lineWith(setup.captureCharFrame(), "echo")).toContain("▶")
    } finally {
      setup.renderer.destroy()
    }
  })

  /* The sidebar has no cursor glyph — the cursor is the selection band — so this
     proves the jump through its effect: jumping to the last item (the
     connection) and pressing Enter connects it. A stray `gg` would leave the
     cursor on the project and collapse it instead. */
  test("Shift+G jumps the sidebar cursor to the last item", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile(),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("○ main"))

      await pressKeys(setup, ["SHIFT+g", "RETURN"])
      await setup.waitForFrame(f => f.includes("▌ USERS"))
    } finally {
      setup.renderer.destroy()
    }
  })
  /* `q` is vim's quit, but it is only safe where nothing is mid-edit: the
     guards ahead of it hand the key to a text field first, and VISUAL mode
     holds it so a selection cannot vanish along with the process. */
  describe("q quits the app", () => {
    test("NORMAL mode exits", async () => {
      const services = await resolveTestServices(freshConfigFile())
      const exits: number[] = []
      const setup = await renderApp(
        <App theme={makeTheme("dark")} services={services.services} exit={c => exits.push(c)} />
      )
      try {
        await pressKeys(setup, ["q"])
        expect(exits).toEqual([0])
      } finally {
        setup.renderer.destroy()
      }
    })

    test("a VISUAL selection refuses it", async () => {
      const services = await resolveTestServices(freshConfigFile())
      await seedProject(services.store, {
        name: "demo",
        database: "main",
        engine: "sqlite",
        filename: freshSqliteDataFile(),
      })
      const exits: number[] = []
      const setup = await renderApp(
        <App theme={makeTheme("dark")} services={services.services} exit={c => exits.push(c)} />
      )
      try {
        await expandToConnection(setup)
        await pressKeys(setup, ["l"])
        await pressKeys(setup, ["SHIFT+v"])
        await setup.waitForFrame(f => f.includes("VISUAL"))

        await pressKeys(setup, ["q"])
        expect(exits).toEqual([])
        /* The selection is still open, so nothing was silently discarded. */
        await setup.waitForFrame(f => f.includes("VISUAL"))
      } finally {
        setup.renderer.destroy()
      }
    })

    test("the finder types it instead of quitting", async () => {
      const services = await resolveTestServices(freshConfigFile())
      const exits: number[] = []
      const setup = await renderApp(
        <App theme={makeTheme("dark")} services={services.services} exit={c => exits.push(c)} />
      )
      try {
        await pressKeys(setup, [" "])
        await setup.waitForFrame(f => f.includes("type to filter"))
        await pressKeys(setup, ["q"])

        expect(exits).toEqual([])
        /* `q` reached the query, which is the whole point of the guard order. */
        expect(setup.captureCharFrame()).toContain("q")
      } finally {
        setup.renderer.destroy()
      }
    })
  })
})
