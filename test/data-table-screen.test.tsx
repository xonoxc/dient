/**
 * Data table screen tests — the table area as rendered by the real App against
 * a seeded SQLite file. Driving the table needs the `l` focus switch after
 * connecting, since Enter on a connection leaves focus on the sidebar. Each
 * tree step is an async DB round-trip, so the presses are staged like human
 * input.
 */
import { describe, expect, test } from "bun:test"
import App from "@/app"
import { makeTheme } from "@/theme"
import { pressKeys, renderApp } from "@test/support/render-ui"
import {
  freshConfigFile,
  freshSqliteDataFile,
  resolveTestServices,
  seedProject,
} from "@test/support/services-fixture"

/** Drill down to the seeded users table, then move focus to the table panel. */
async function openTable(setup: Awaited<ReturnType<typeof renderApp>>, waitLine: string) {
  await pressKeys(setup, ["RETURN"])
  await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("▸ main"))
  await pressKeys(setup, ["j", "RETURN"])
  await setup.waitForFrame(f => f.includes("○ data.db"))
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

describe("data table", () => {
  test("renders aligned column headers and values from metadata", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: freshSqliteDataFile() })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      const frame = await openTable(setup, "alice")
      /* header cells are padded to their column widths, so they line up */
      expect(frame).toContain("ID  NAME EMAIL")
      expect(frame).toContain("1   alice")
      expect(frame).toContain("3   carol")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("j/k move the selection arrow down/up and the status bar counts rows", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: freshSqliteDataFile() })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openTable(setup, "alice")
      expect(setup.captureCharFrame()).toContain("3 rows")

      await pressKeys(setup, ["j"])
      await setup.waitForFrame(f => f.includes("▶2"))
      expect(setup.captureCharFrame()).toContain("▶2   bob")

      await pressKeys(setup, ["j"])
      await setup.waitForFrame(f => f.includes("▶3"))
      expect(setup.captureCharFrame()).toContain("▶3   carol")

      await pressKeys(setup, ["k", "k"])
      await setup.waitForFrame(f => f.includes("▶1"))
      expect(setup.captureCharFrame()).toContain("▶1   alice")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("G jumps to the last row page of a huge table, gg back to the first", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: freshSqliteDataFile("users", bigRows) })
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
      await setup.waitForFrame(f => f.includes("▶1   user_0"))
      const first = setup.captureCharFrame()
      expect(first).toContain("▶1   user_0")
      expect(first).not.toContain("user_199")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("the window slides around the cursor within a huge table", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: freshSqliteDataFile("users", bigRows) })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openTable(setup, "user_0")

      /* j x 4 → cursor sits inside the initial pinned window, top rows visible */
      await pressKeys(setup, ["j", "j", "j", "j"])
      await setup.waitForFrame(f => f.includes("▶5"))
      const nearTop = setup.captureCharFrame()
      expect(nearTop).toContain("▶5   user_4")
      expect(nearTop).toContain("user_0")

      /* 5 more j → cursor 9 is past the viewport half, so the window recenters
         and drops the top rows */
      await pressKeys(setup, ["j", "j", "j", "j", "j"])
      await setup.waitForFrame(f => f.includes("▶10"))
      const centered = setup.captureCharFrame()
      expect(centered).toContain("▶10  user_9")
      expect(centered).not.toContain("user_0")
    } finally {
      setup.renderer.destroy()
    }
  })
})