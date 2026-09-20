/**
 * Sidebar screen tests — the project tree as rendered by the real App against
 * seeded config data. Keyboard flows are staged like human input: expanding a
 * node is a DB round-trip that must settle before navigating into the new
 * children, so each expansion is awaited before the next press.
 */
import { describe, expect, test } from "bun:test"
import App from "@/app"
import { makeTheme } from "@/theme"
import { pressKeys, renderApp } from "@test/support/render-ui"
import { freshConfigFile, freshSqliteDataFile, resolveTestServices, seedProject } from "@test/support/services-fixture"

/* Open the tree down to the database row (project → database/connection). */
async function expandToDatabase(setup: Awaited<ReturnType<typeof renderApp>>) {
  await pressKeys(setup, ["RETURN"])
  await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("○ main"))
  await pressKeys(setup, ["j"])
  await setup.waitForFrame(f => f.includes("main"))
}

describe("sidebar tree", () => {
  test("renders the project tree from ConfigStore", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: "data.db" })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      const frame = setup.captureCharFrame()
      expect(frame).toContain("PROJECTS")
      expect(frame).toContain("▸ demo")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("Enter expands a project to reveal its database, and Enter there connects it", async () => {
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
      await setup.waitForFrame(f => f.includes("▾ demo") && (f.includes("○ main") || f.includes("○ main")))
      expect(setup.captureCharFrame()).toContain("main")

      /* Enter on the database row both connects and expands its table list */
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("●") && f.includes("USERS") && f.includes("alice"))
    } finally {
      setup.renderer.destroy()
    }
  })

  test("j/k navigate the tree and Enter opens the row under the cursor", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile("users"),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await expandToDatabase(setup)

      /* cursor rests on the database row; Enter connects and opens its tables */
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("USERS") && f.includes("alice"))
      expect(setup.captureCharFrame()).toContain("alice")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("k moves back up, and Enter there collapses the node", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: "x.db" })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("○ main"))

      /* cursor is on the project; j → main, k → back onto the project, Enter
         collapses it again */
      await pressKeys(setup, ["j", "k", "RETURN"])
      await setup.waitForFrame(f => f.includes("▸ demo") && !f.includes("main"))
      expect(setup.captureCharFrame()).not.toContain("main")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("the connection status dot flips from ○ to ● once connected", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile("users"),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await expandToDatabase(setup)
      expect(setup.captureCharFrame()).toContain("○ main")

      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("●") && f.includes("USERS"))
      expect(setup.captureCharFrame()).not.toContain("○ main")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("an empty config shows a friendly empty panel", async () => {
    const services = await resolveTestServices(freshConfigFile())
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      const frame = setup.captureCharFrame()
      expect(frame).toContain("PROJECTS")
      expect(frame).toContain("no projects yet")
    } finally {
      setup.renderer.destroy()
    }
  })
})
