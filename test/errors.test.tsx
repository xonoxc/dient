/**
 * Error handling tests — the app surfaces failures through toasts and the
 * confirmation modal without crashing, toasts auto-dismiss, the modal blocks
 * interaction until dismissed, and a failed connection offers a retry.
 */
import { describe, expect, test } from "bun:test"
import { useEffect } from "react"
import { Effect } from "effect"
import App from "@/app"
import { makeTheme } from "@/theme"
import { ThemeProvider } from "@/theme-context"
import { ToastProvider, useToasts } from "@/app-context"
import { ToastView } from "@/ui/toast"
import { pressKeys, renderApp } from "@test/support/render-ui"
import { freshConfigFile, freshSqliteDataFile, resolveTestServices, seedProject } from "@test/support/services-fixture"

/* A SQLite connection whose file lives in a missing directory always fails to
   open, giving us a deterministic connect error without needing containers. */
const BROKEN_FILE = "/nonexistent-dient-dir/data.db"

describe("error handling", () => {
  test("a failed connection shows a toast and a retry prompt, and the app survives", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: BROKEN_FILE })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("○ main"))
      await pressKeys(setup, ["j", "RETURN"])

      /* the error surfaces as a toast and as a modal offering a retry (the
         toast itself sits behind the modal's sheet, but the title shows) */
      await setup.waitForFrame(f => f.includes("failed") && f.includes("retry"))

      /* retrying re-attempts the connection and fails again → modal reopens */
      await pressKeys(setup, ["y"])
      await setup.waitForFrame(f => f.includes("retry"))

      /* dismissing the prompt leaves a usable app behind */
      await pressKeys(setup, ["n"])
      await setup.waitForFrame(f => !f.includes("retry"))
      const frame = setup.captureCharFrame()
      expect(frame).toContain("PROJECTS")
      expect(frame).toContain("▾ demo")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("toasts auto-dismiss after their timeout", async () => {
    function Transient() {
      const { push } = useToasts()
      useEffect(() => {
        push("info", "transient message", 40)
      }, [push])
      return null
    }
    const setup = await renderApp(
      <ThemeProvider theme={makeTheme("dark")}>
        <ToastProvider>
          <Transient />
          <ToastView />
        </ToastProvider>
      </ThemeProvider>
    )
    try {
      await setup.waitForFrame(f => f.includes("transient message"))
      await new Promise(resolve => setTimeout(resolve, 120))
      await setup.waitForVisualIdle()
      expect(setup.captureCharFrame()).not.toContain("transient message")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("the confirmation modal blocks interaction until dismissed", async () => {
    const services = await resolveTestServices(freshConfigFile())
    const seeded = await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: "data.db",
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      /* open settings and walk the tree down to the database */
      await pressKeys(setup, [":", "s", "e", "t", "t", "i", "n", "g", "s", "RETURN"])
      await setup.waitForFrame(f => f.includes("SETTINGS"))
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("○ main"))
      await pressKeys(setup, ["j"])

      await pressKeys(setup, ["d"])
      await setup.waitForFrame(f => f.includes("Delete database") && f.includes("main"))
      const before = await Effect.runPromise(services.store.listDatabases(seeded.project.id))
      expect(before.length).toBe(1)

      /* a stray key neither confirms nor cancels the destructive action */
      await pressKeys(setup, ["j"])
      expect(setup.captureCharFrame()).toContain("Delete database")

      /* Esc cancels; nothing was deleted */
      await pressKeys(setup, ["ESCAPE"])
      await setup.waitForFrame(f => !f.includes("Delete database"))
      const afterEscape = await Effect.runPromise(services.store.listDatabases(seeded.project.id))
      expect(afterEscape.length).toBe(1)

      /* and the flow still works for a real confirm afterwards */
      await pressKeys(setup, ["d"])
      await setup.waitForFrame(f => f.includes("Delete database"))
      await pressKeys(setup, ["y"])
      await setup.waitForFrame(f => f.includes("database deleted"))
      const afterDelete = await Effect.runPromise(services.store.listDatabases(seeded.project.id))
      expect(afterDelete.length).toBe(0)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("seeded connection data is untouched when nothing errors", async () => {
    const services = await resolveTestServices(freshConfigFile())
    const seeded = await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile("users"),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("○ main"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("USERS") && f.includes("alice"))
      const remaining = await Effect.runPromise(services.store.listConnections(seeded.database.id))
      expect(remaining.length).toBe(1)
    } finally {
      setup.renderer.destroy()
    }
  })
})
