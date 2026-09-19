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
import {
  freshConfigFile,
  freshSqliteDataFile,
  resolveTestServices,
  seedProject,
} from "@test/support/services-fixture"

async function expandToConnection(setup: Awaited<ReturnType<typeof renderApp>>, dataFile: string) {
  await pressKeys(setup, ["RETURN"])
  await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("▸ main"))
  await pressKeys(setup, ["j", "RETURN"])
  await setup.waitForFrame(f => f.includes(`○ ${dataFile}`))
  await pressKeys(setup, ["j", "RETURN"])
  await setup.waitForFrame(f => f.includes("USERS") && f.includes("alice"))
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
  test("connecting to a connection loads its tables into the strip and opens the first table", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: freshSqliteDataFile() })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await expandToConnection(setup, "data.db")
      const frame = setup.captureCharFrame()
      expect(frame).toContain("▶ USERS")
      expect(frame).toContain("alice")
      expect(frame).toContain("data.db@main")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("Tab cycles connections and refreshes table list, data, and status", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: freshSqliteDataFile() })
    await seedProject(services.store, {
      name: "beta",
      database: "app",
      engine: "sqlite",
      filename: ordersFile(),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      /* projects render name-sorted, so beta is the first row: expand beta, its
         database, then connect to the orders connection */
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ beta") && f.includes("▸ app"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("○ orders.db"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("▶ ORDERS") && f.includes("iphone"))
      const beta = setup.captureCharFrame()
      expect(beta).toContain("orders.db@app")
      expect(beta).not.toContain("alice")

      /* cursor sits on orders.db; walk down and expand the demo project too */
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("▸ main"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("○ data.db"))

      /* Tab wraps around to the first connection: data.db is back in the strip */
      await pressKeys(setup, ["TAB"])
      await setup.waitForFrame(f => f.includes("▶ USERS") && f.includes("alice"))
      const back = setup.captureCharFrame()
      expect(back).toContain("data.db@main")
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
      await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("▸ main"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("○ data.db"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("no tables") && f.includes("no rows"))
      const frame = setup.captureCharFrame()
      expect(frame).toContain("no tables")
      expect(frame).toContain("no rows")
    } finally {
      setup.renderer.destroy()
    }
  })
})