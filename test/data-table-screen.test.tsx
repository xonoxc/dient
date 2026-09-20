/**
 * Data table screen tests — the table area as rendered by the real App against
 * a seeded SQLite file. Driving the table needs the `l` focus switch after
 * connecting, since Enter on a connection leaves focus on the sidebar. Each
 * tree step is an async DB round-trip, so the presses are staged like human
 * input.
 */
import { describe, expect, test } from "bun:test"
import { Database as SqliteDatabase } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import App from "@/app"
import { makeTheme } from "@/theme"
import { pressKeys, renderApp } from "@test/support/render-ui"
import { freshConfigFile, freshSqliteDataFile, resolveTestServices, seedProject } from "@test/support/services-fixture"

/** Drill down to the seeded users table, then move focus to the table panel. */
async function openTable(setup: Awaited<ReturnType<typeof renderApp>>, waitLine: string) {
  await pressKeys(setup, ["RETURN"])
  await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("○ main"))
  await pressKeys(setup, ["j", "RETURN"])
  await setup.waitForFrame(f => f.includes(waitLine))
  await pressKeys(setup, ["l"])
  return setup.captureCharFrame()
}

const bigRows: ReadonlyArray<Record<string, unknown>> = Array.from({ length: 1500 }, (_, i) => ({
  id: i + 1,
  name: `user_${i}`,
  email: `user_${i}@example.com`,
}))

/** A data file whose table is far wider than the table pane. */
const wideDataFile = (): string => {
  const path = join(mkdtempSync(join(tmpdir(), "dient-wide-")), "data.db")
  const db = new SqliteDatabase(path)
  db.run(
    `CREATE TABLE invoices (
       id INTEGER PRIMARY KEY,
       customer_name TEXT,
       billing_email TEXT,
       last_order_date TEXT,
       total_due REAL
     )`
  )
  db.run(
    `INSERT INTO invoices (id, customer_name, billing_email, last_order_date, total_due)
     VALUES (1, 'Acme Consolidation Group Ltd', 'billing@acme-consolidated.example', '2026-09-20 11:42', 12345.67)`
  )
  db.close()
  return path
}

describe("data table", () => {
  test("renders aligned column headers and values from metadata", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile(),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      const frame = await openTable(setup, "alice")
      /* columns are padded to their (gutter + shared) widths, so headers and
         values line up with at least two spaces of separation */
      expect(frame).toMatch(/ID\s{2,}NAME\s{2,}EMAIL/)
      expect(frame).toMatch(/1\s{2,}alice/)
      expect(frame).toMatch(/3\s{2,}carol/)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("j/k move the selection arrow down/up and the status bar counts rows", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile(),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openTable(setup, "alice")
      expect(setup.captureCharFrame()).toContain("3 rows")

      await pressKeys(setup, ["j"])
      await setup.waitForFrame(f => f.includes("▶2"))
      expect(setup.captureCharFrame()).toMatch(/▶2\s+bob/)

      await pressKeys(setup, ["j"])
      await setup.waitForFrame(f => f.includes("▶3"))
      expect(setup.captureCharFrame()).toMatch(/▶3\s+carol/)

      await pressKeys(setup, ["k", "k"])
      await setup.waitForFrame(f => f.includes("▶1"))
      expect(setup.captureCharFrame()).toMatch(/▶1\s+alice/)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("G jumps to the last row page of a huge table, gg back to the first", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile("users", bigRows),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openTable(setup, "user_0")
      /* the query executor fetches a 200-row page but reports the real total */
      expect(setup.captureCharFrame()).toContain("200 / 1500 rows")

      await pressKeys(setup, ["G"])
      await setup.waitForFrame(f => f.includes("▶200"))
      const last = setup.captureCharFrame()
      expect(last).toContain("▶200")
      expect(last).toContain("user_199")
      /* the loaded page stays virtualized: first rows are not in the frame */
      expect(last).not.toContain("user_0")

      await pressKeys(setup, ["g", "g"])
      await setup.waitForFrame(f => f.includes("▶1"))
      const first = setup.captureCharFrame()
      expect(first).toMatch(/▶1\s+user_0/)
      expect(first).not.toContain("user_199")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("the window slides around the cursor within a huge table", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile("users", bigRows),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openTable(setup, "user_0")

      /* j x 4 → cursor sits inside the initial pinned window, top rows visible */
      await pressKeys(setup, ["j", "j", "j", "j"])
      await setup.waitForFrame(f => f.includes("▶5"))
      const nearTop = setup.captureCharFrame()
      expect(nearTop).toMatch(/▶5\s+user_4/)
      expect(nearTop).toContain("user_0")

      /* 13 more j → cursor 18 is past the viewport half (the pane fills the
         terminal now), so the window recenters and drops the top rows */
      await pressKeys(setup, ["j", "j", "j", "j", "j", "j", "j", "j", "j", "j", "j", "j", "j"])
      await setup.waitForFrame(f => f.includes("▶18"))
      const centered = setup.captureCharFrame()
      expect(centered).toMatch(/▶18\s+user_17/)
      expect(centered).not.toContain("user_0")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("pans horizontally to reveal columns past the pane edge", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: wideDataFile(),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openTable(setup, "Acme")

      /* the last column starts off-screen to the right */
      const initial = setup.captureCharFrame()
      expect(initial).toContain("CUSTOMER_NAME")
      expect(initial).not.toContain("TOTAL_DUE")

      /* walking the active column right pans the scrollbox to follow it */
      await pressKeys(setup, ["right", "right", "right", "right"])
      await setup.waitForFrame(f => f.includes("TOTAL_DUE"))
      const panned = setup.captureCharFrame()
      expect(panned).toContain("TOTAL_DUE")
      expect(panned).not.toContain("CUSTOMER_NAME")

      /* and back left returns to the first columns */
      await pressKeys(setup, ["left", "left", "left", "left"])
      await setup.waitForFrame(f => f.includes("CUSTOMER_NAME"))
      const back = setup.captureCharFrame()
      expect(back).toContain("CUSTOMER_NAME")
      expect(back).toContain("ID")
    } finally {
      setup.renderer.destroy()
    }
  })
})
