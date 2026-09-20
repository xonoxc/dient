/**
 * Polish + help tests — the `?` help overlay toggles and lists the keybinding
 * reference, the status bar reports the open table and row count, the sidebar
 * shows the per-connection status dot (including the error state), and boot
 * never opens a connection on its own (deferred connects).
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import App from "@/app"
import { makeTheme } from "@/theme"
import { pressKeys, renderApp } from "@test/support/render-ui"
import { freshConfigFile, freshSqliteDataFile, resolveTestServices, seedProject } from "@test/support/services-fixture"

describe("polish + help", () => {
  test("? opens the help overlay with the keybinding reference, Esc closes it", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: "data.db" })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, ["?"])
      await setup.waitForFrame(f => f.includes("dient · keybindings") && f.includes("j / k"))
      const frame = setup.captureCharFrame()
      expect(frame).toContain(":e <table>")
      expect(frame).toContain(":connect <name>")

      await pressKeys(setup, ["ESCAPE"])
      await setup.waitForFrame(f => !f.includes("keybindings"))
      expect(setup.captureCharFrame()).toContain("PROJECTS")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("the status bar reports the open table and its row count", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
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
      await setup.waitForFrame(f => f.includes("USERS") && f.includes("3 rows"))
      expect(setup.captureCharFrame()).toContain("main · sqlite")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("boot does not open any connection (deferred connects)", async () => {
    const services = await resolveTestServices(freshConfigFile())
    const seeded = await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile("users"),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      const connected = await Effect.runPromise(services.services.connectionManager.isConnected(seeded.connection.id))
      expect(connected).toBe(false)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("a failed connection shows the red error dot after the prompt is dismissed", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: "/nonexistent-dient-dir/data.db",
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("○ main"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("failed") && f.includes("retry"))

      await pressKeys(setup, ["n"])
      await setup.waitForFrame(f => f.includes("◉") && f.includes("main"))
    } finally {
      setup.renderer.destroy()
    }
  })
})
