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
import {
  freshConfigFile,
  freshSqliteDataFile,
  resolveTestServices,
  seedProject,
} from "@test/support/services-fixture"

/* Open the tree down to the connection row: project → database → connection. */
async function expandToConnection(setup: Awaited<ReturnType<typeof renderApp>>, dataFile: string) {
  await pressKeys(setup, ["RETURN"])
  await setup.waitForFrame(f => f.includes("▾ demo"))
  await pressKeys(setup, ["j", "RETURN"])
  await setup.waitForFrame(f => f.includes(`○ ${dataFile}`))
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

  test("Enter expands a project to reveal its databases, and a database its connections", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: "data.db" })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("▸ main"))
      expect(setup.captureCharFrame()).toContain("main")

      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("▾ main") && f.includes(`○ data.db`))
      expect(setup.captureCharFrame()).toContain("data.db")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("j/k navigate the tree and Enter opens the row under the cursor", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: freshSqliteDataFile("users") })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await expandToConnection(setup, "data.db")

      /* cursor rests on the database after expanding it; j walks down to the
         connection, and Enter on it connects and loads the table */
      await pressKeys(setup, ["j", "RETURN"])
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
      await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("▸ main"))

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
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: freshSqliteDataFile("users") })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await expandToConnection(setup, "data.db")
      expect(setup.captureCharFrame()).toContain("○ data.db")

      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("●") && f.includes("USERS"))
      expect(setup.captureCharFrame()).not.toContain("○ data.db")
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