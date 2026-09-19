/**
 * Cell editor screen tests — Enter opens an inline editor on the cursor cell,
 * typing drafts into it, Enter persists through the write path (UPDATE via the
 * primary key), Escape/Ctrl-c cancels, and commits validate against the column
 * type before saving.
 */
import { describe, expect, test } from "bun:test"
import { act } from "react"
import App from "@/app"
import { makeTheme } from "@/theme"
import { pressKeys, renderApp } from "@test/support/render-ui"
import {
  freshConfigFile,
  freshSqliteDataFile,
  resolveTestServices,
  seedProject,
} from "@test/support/services-fixture"

/** Connect to the seeded users table and move focus to the table panel. */
async function openTable(setup: Awaited<ReturnType<typeof renderApp>>) {
  await pressKeys(setup, ["RETURN"])
  await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("▸ main"))
  await pressKeys(setup, ["j", "RETURN"])
  await setup.waitForFrame(f => f.includes("○ data.db"))
  await pressKeys(setup, ["j", "RETURN"])
  await setup.waitForFrame(f => f.includes("USERS") && f.includes("alice"))
  await pressKeys(setup, ["l"])
}

/** Run a raw mock-terminal press (arrows, ctrl combos) inside an act() batch. */
async function rawPress(
  setup: Awaited<ReturnType<typeof renderApp>>,
  press: () => void
): Promise<void> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  try {
    await act(async () => {
      press()
      setup.renderOnce()
      setup.flush()
    })
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  }
  await setup.waitForVisualIdle()
}

const CLEAR = ["BACKSPACE", "BACKSPACE", "BACKSPACE", "BACKSPACE", "BACKSPACE"] as const

describe("cell editor", () => {
  test("Enter opens the editor on the cursor cell showing the current value", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: freshSqliteDataFile() })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openTable(setup)
      /* cursor is on id (column 0); typing drafts into the cell that starts
         with the current value "1" */
      await pressKeys(setup, ["RETURN", "7"])
      await setup.waitForFrame(f => f.includes("17"))
      expect(setup.captureCharFrame()).toContain("17")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("edit + Enter saves through the write path and reloads the table", async () => {
    const services = await resolveTestServices(freshConfigFile())
    const seedFile = freshSqliteDataFile()
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: seedFile })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openTable(setup)

      /* move the column cursor to name (column 1), then overwrite alice → amy */
      await rawPress(setup, () => setup.mockInput.pressArrow("right"))
      await pressKeys(setup, ["RETURN", ...CLEAR, "a", "m", "y", "RETURN"])
      await setup.waitForFrame(f => f.includes("amy"))
      const frame = setup.captureCharFrame()
      expect(frame).toContain("amy")
      expect(frame).not.toContain("▶1   alice")
      expect(frame).toContain("alice@example.com")
      /* the write path persisted to the data file too */
      const db = new (await import("bun:sqlite")).Database(seedFile)
      const names = db.query("SELECT name FROM users WHERE id = 1").get() as { name: string }
      expect(names.name).toBe("amy")
      db.close()
    } finally {
      setup.renderer.destroy()
    }
  })

  test("Escape cancels the edit and leaves the cell untouched", async () => {
    const services = await resolveTestServices(freshConfigFile())
    const seedFile = freshSqliteDataFile()
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: seedFile })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openTable(setup)
      await pressKeys(setup, ["RETURN", "2"])
      await setup.waitForFrame(f => f.includes("12"))
      expect(setup.captureCharFrame()).toContain("12")

      await pressKeys(setup, ["ESCAPE"])
      /* the draft is discarded; the cell shows its original value again */
      await setup.waitForFrame(f => f.includes("▶1"))
      expect(setup.captureCharFrame()).not.toContain("12")
      const db = new (await import("bun:sqlite")).Database(seedFile)
      const names = db.query("SELECT id FROM users WHERE id = 1").get() as { id: number }
      expect(names.id).toBe(1)
      db.close()
    } finally {
      setup.renderer.destroy()
    }
  })

  test("a numeric cell rejects non-numeric drafts before saving", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: freshSqliteDataFile() })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openTable(setup)
      await pressKeys(setup, ["RETURN", "a"])
      await setup.waitForFrame(f => f.includes("1a"))
      expect(setup.captureCharFrame()).toContain("1a")

      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("expects a number"))
      const frame = setup.captureCharFrame()
      expect(frame).toContain("expects a number")
      /* the editor stays open with the invalid draft across the rejected save */
      expect(frame).toContain("1a")
    } finally {
      setup.renderer.destroy()
    }
  })
})