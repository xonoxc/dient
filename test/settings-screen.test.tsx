/**
 * Settings screen tests — connection CRUD driven through the real App against
 * seeded config data. Removing a connection goes through the confirmation
 * modal, adding one through the multi-field connection form, so each stage
 * (open form, type, submit) is pressed and awaited separately like human
 * input.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import App from "@/app"
import { makeTheme } from "@/theme"
import { pressKeys, renderApp } from "@test/support/render-ui"
import {
  freshConfigFile,
  freshSqliteDataFile,
  resolveTestServices,
  seedProject,
} from "@test/support/services-fixture"

/* Navigate to the settings screen through the `:` command line. */
async function openSettings(setup: Awaited<ReturnType<typeof renderApp>>) {
  await pressKeys(setup, [":", "s", "e", "t", "t", "i", "n", "g", "s", "RETURN"])
  await setup.waitForFrame(f => f.includes("SETTINGS"))
}

/* Expand the project tree one level: project → database, revealing connections. */
async function expandDatabase(setup: Awaited<ReturnType<typeof renderApp>>) {
  await pressKeys(setup, ["RETURN"])
  await setup.waitForFrame(f => f.includes("▾ demo"))
  await pressKeys(setup, ["j"])
  await pressKeys(setup, ["RETURN"])
  await setup.waitForFrame(f => f.includes("• "))
}

describe("settings screen", () => {
  test("renders existing connections in the config tree", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: "data.db" })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openSettings(setup)
      await expandDatabase(setup)

      const frame = setup.captureCharFrame()
      expect(frame).toContain("demo")
      expect(frame).toContain("main")
      expect(frame).toContain("• data.db")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("the connection form validates required fields (filename)", async () => {
    const services = await resolveTestServices(freshConfigFile())
    const seeded = await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: "data.db" })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openSettings(setup)
      await expandDatabase(setup)

      /* cursor is on the database; a opens a connection form under it */
      await pressKeys(setup, ["a"])
      await setup.waitForFrame(f => f.includes("new connection") && f.includes("filename:"))

      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("a sqlite connection requires a filename"))
      /* still in the form, nothing was persisted */
      expect(setup.captureCharFrame()).toContain("new connection")
      const remaining = await Effect.runPromise(services.store.listConnections(seeded.database.id))
      expect(remaining.length).toBe(1)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("saving the connection form creates a connection in ConfigStore", async () => {
    const services = await resolveTestServices(freshConfigFile())
    const seeded = await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: "data.db" })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openSettings(setup)
      await expandDatabase(setup)

      await pressKeys(setup, ["a"])
      await setup.waitForFrame(f => f.includes("new connection"))
      await pressKeys(setup, ["n", "e", "w", ".", "d", "b"])
      await setup.waitForFrame(f => f.includes("new.db"))

      await pressKeys(setup, ["RETURN"])
      /* the new row appears under the database, distinct from the toast text */
      await setup.waitForFrame(f => f.includes("• new.db"))

      const remaining = await Effect.runPromise(services.store.listConnections(seeded.database.id))
      expect(remaining.length).toBe(2)
      expect(remaining.some(connection => connection.filename === "new.db")).toBe(true)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("deleting a connection asks for confirmation and removes it", async () => {
    const services = await resolveTestServices(freshConfigFile())
    const seeded = await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: "data.db" })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openSettings(setup)
      await expandDatabase(setup)

      /* cursor: project → database → connection */
      await pressKeys(setup, ["j"])
      await pressKeys(setup, ["d"])
      await setup.waitForFrame(f => f.includes("Delete connection") && f.includes("data.db"))

      await pressKeys(setup, ["y"])
      await setup.waitForFrame(f => f.includes("connection deleted"))
      await setup.waitForFrame(f => !f.includes("• data.db"))

      const remaining = await Effect.runPromise(services.store.listConnections(seeded.database.id))
      expect(remaining.length).toBe(0)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("t tests the connection under the cursor against the engine", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: freshSqliteDataFile("users"),
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openSettings(setup)
      await expandDatabase(setup)

      await pressKeys(setup, ["j"])
      await pressKeys(setup, ["t"])
      await setup.waitForFrame(f => f.includes("connection ok"))
    } finally {
      setup.renderer.destroy()
    }
  })
})