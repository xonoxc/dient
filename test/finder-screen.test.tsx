/**
 * Finder (telescope-style) integration — space opens the overlay listing the
 * current database's tables plus every project/database from the config store,
 * typing fuzzy-filters the list, and Enter jumps to the highlighted hit.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Database as SqliteDatabase } from "bun:sqlite"
import App from "@/app"
import { makeTheme } from "@/theme"
import { pressKeys, renderApp } from "@test/support/render-ui"
import { freshConfigFile, resolveTestServices, seedProject } from "@test/support/services-fixture"

/** A data file with two tables so the finder sees multiple table hits. */
const twoTableDataFile = (): string => {
  const path = `${freshConfigFile()}.data.db`
  const db = new SqliteDatabase(path)
  db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)`)
  db.run(`INSERT INTO users (id, name, email) VALUES (1, 'alice', 'alice@example.com')`)
  db.run(`CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT, qty INTEGER, total REAL)`)
  db.run(`INSERT INTO orders (id, item, qty, total) VALUES (1, 'widget', 3, 9.99)`)
  db.close()
  return path
}

describe("finder", () => {
  test("space opens it, typing filters, Enter jumps to the table", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: twoTableDataFile(),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      /* connect `main`: it auto-opens the first table (orders) and parks focus
         on the sidebar */
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("○ main"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("ITEM"))

      /* space opens the overlay listing tables (ranked first), then db, project */
      await pressKeys(setup, [" "])
      await setup.waitForFrame(f => f.includes("matches"))
      const open = setup.captureCharFrame()
      expect(open).toContain("users")
      expect(open).toContain("main")
      expect(open).toContain("demo")
      expect(open).toContain("tbl")

      /* fuzzy filter to the users table, jump on Enter */
      await pressKeys(setup, ["u", "s"])
      await setup.waitForFrame(f => f.includes("1 match"))

      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("alice"))
      const landed = setup.captureCharFrame()
      expect(landed).toContain("USERS")
      expect(landed).toContain("EMAIL")
      /* the overlay is gone */
      expect(landed).not.toContain("matches")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("Escape closes the overlay without jumping", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: twoTableDataFile(),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("○ main"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("ITEM"))

      /* open the finder and aim at the users table… */
      await pressKeys(setup, [" "])
      await setup.waitForFrame(f => f.includes("matches"))
      await pressKeys(setup, ["u", "s"])
      await setup.waitForFrame(f => f.includes("1 match"))

      /* …then back out: the orders table stays put, alice is never shown */
      await pressKeys(setup, ["ESCAPE"])
      await setup.waitForFrame(f => !f.includes("matches"))
      const closed = setup.captureCharFrame()
      expect(closed).toContain("ITEM")
      expect(closed).not.toContain("alice")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("jumping to a database from a collapsed project connects and expands it", async () => {
    const services = await resolveTestServices(freshConfigFile())
    const seeded = await seedProject(services.store, {
      name: "demo",
      database: "sample",
      engine: "sqlite",
      filename: twoTableDataFile(),
    })
    /* A second database in the *same* project: the jump should reveal the
       siblings but select only the hit. */
    const other = await Effect.runPromise(
      services.store.createDatabase({ projectId: seeded.project.id, name: "other", engine: "sqlite" })
    )
    await Effect.runPromise(
      services.store.createConnection({ databaseId: other.id, filename: twoTableDataFile() })
    )
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      /* the project starts collapsed: no database rows exist yet */
      await setup.waitForFrame(f => f.includes("▸ demo"))
      expect(setup.captureCharFrame()).not.toContain("sample")

      await pressKeys(setup, [" "])
      await setup.waitForFrame(f => f.includes("matches"))
      await pressKeys(setup, ["s", "a", "m"])
      await setup.waitForFrame(f => f.includes("1 match"))
      await pressKeys(setup, ["RETURN"])

      /* The database connects and expands: the active marker and its tables
         appear, while the sibling is listed but not selected. */
      await setup.waitForFrame(f => f.includes("▶") && f.includes("users") && f.includes("orders"))
      const landed = setup.captureCharFrame()
      /* The sidebar is the pane left of the divider; the data pane shares each
         terminal row, so isolate the left column before scanning. */
      const sidebarLines = landed.split("\n").map(line => line.split("│")[0] ?? "")
      const sampleLine = sidebarLines.find(line => line.includes("sample") && line.includes("SQLite"))
      const otherLine = sidebarLines.find(line => line.includes("other") && line.includes("SQLite"))
      expect(sampleLine).toBeDefined()
      expect(otherLine).toBeDefined()
      expect(sampleLine!).toContain("▶")
      expect(otherLine!).not.toContain("▶")
      expect(landed).toContain("users")
      expect(landed).toContain("orders")
    } finally {
      setup.renderer.destroy()
    }
  })
})
