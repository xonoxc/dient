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
import { pressKeys, renderApp } from "@test/support/render-ui"
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
     `FiberFailure` dump whose stack spilled out of the 60-column modal and
     mangled its border, under a title reading
     `Connection "game_service · game_service" failed`. Both halves came from
     the same mistake — treating a rejection as something to print. */
  test("shows one short line inside the border, with the name stated once", async () => {
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

      const rows = frame.split("\n")
      expect(rows.filter(row => row.includes("Failed to connect"))).toHaveLength(1)
      /* Everything on the rendered body row sits inside the border. */
      const bodyLine = rows.find(row => row.includes("Failed to connect")) ?? ""
      const left = bodyLine.indexOf("│")
      const right = bodyLine.lastIndexOf("│")
      expect(left).toBeGreaterThanOrEqual(0)
      expect(right).toBeGreaterThan(left)
      const text = bodyLine.slice(left + 1, right)
      expect(text.trim().length).toBeGreaterThan(0)
      expect(text.length).toBeLessThanOrEqual(right - left - 1)
    } finally {
      setup.renderer.destroy()
    }
  }, 30000)
})
