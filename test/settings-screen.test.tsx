/**
 * Settings screen tests — project/database CRUD driven through the real App
 * against seeded config data. Adding a database is a single connection-string
 * paste (`new.db` parses as SQLite, naming the database from the tail), so
 * each stage (open form, type, submit) is pressed and awaited separately like
 * human input.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import App from "@/app"
import { makeTheme } from "@/theme"
import { pressKeys, renderApp } from "@test/support/render-ui"
import { freshConfigFile, freshSqliteDataFile, resolveTestServices, seedProject } from "@test/support/services-fixture"

/* Navigate to the settings screen through the `:` command line. */
async function openSettings(setup: Awaited<ReturnType<typeof renderApp>>) {
  await pressKeys(setup, [":", "s", "e", "t", "t", "i", "n", "g", "s", "RETURN"])
  await setup.waitForFrame(f => f.includes("SETTINGS"))
}

/* Expand the project tree one level, landing the cursor on the database row. */
async function expandProject(setup: Awaited<ReturnType<typeof renderApp>>) {
  await pressKeys(setup, ["RETURN"])
  await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("○ main"))
  await pressKeys(setup, ["j"])
}

describe("settings screen", () => {
  test("renders existing databases in the config tree", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: "data.db" })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openSettings(setup)
      await expandProject(setup)

      const frame = setup.captureCharFrame()
      expect(frame).toContain("demo")
      expect(frame).toContain("main")
      expect(frame).toContain("data.db")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("the connection form validates the pasted string", async () => {
    const services = await resolveTestServices(freshConfigFile())
    const seeded = await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: "data.db",
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openSettings(setup)
      await expandProject(setup)

      /* cursor is on the database; a opens the connection-string prompt */
      await pressKeys(setup, ["a"])
      await setup.waitForFrame(f => f.includes("new database") && f.includes("connection string"))

      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("could not parse that connection string"))
      /* still in the form, nothing was persisted */
      expect(setup.captureCharFrame()).toContain("new database")
      const remaining = await Effect.runPromise(services.store.listDatabases(seeded.project.id))
      expect(remaining.length).toBe(1)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("pasting a connection string creates the database and its connection", async () => {
    const services = await resolveTestServices(freshConfigFile())
    const seeded = await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: "data.db",
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openSettings(setup)
      await expandProject(setup)

      await pressKeys(setup, ["a"])
      await setup.waitForFrame(f => f.includes("new database"))
      await pressKeys(setup, ["n", "e", "w", ".", "d", "b"])
      await setup.waitForFrame(f => f.includes("new.db"))

      await pressKeys(setup, ["RETURN"])
      /* the new row appears with its connection params (the name comes from
         the string's tail: new.db → "new") */
      await setup.waitForFrame(f => f.includes("added new") && f.includes("new.db"))

      const databases = await Effect.runPromise(services.store.listDatabases(seeded.project.id))
      expect(databases).toHaveLength(2)
      const added = databases.find(database => database.name === "new")
      expect(added).toBeDefined()
      const connections = added ? await Effect.runPromise(services.store.listConnections(added.id)) : []
      expect(connections).toHaveLength(1)
      expect(connections[0]!.filename).toBe("new.db")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("deleting a database asks for confirmation and removes it", async () => {
    const services = await resolveTestServices(freshConfigFile())
    const seeded = await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: "data.db",
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openSettings(setup)
      await expandProject(setup)

      await pressKeys(setup, ["d"])
      await setup.waitForFrame(f => f.includes("Delete database") && f.includes("main"))

      await pressKeys(setup, ["y"])
      await setup.waitForFrame(f => f.includes("database deleted"))
      await setup.waitForFrame(f => !f.includes("main"))

      const remaining = await Effect.runPromise(services.store.listDatabases(seeded.project.id))
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
      await expandProject(setup)

      await pressKeys(setup, ["t"])
      await setup.waitForFrame(f => f.includes("ok (sqlite)"))
    } finally {
      setup.renderer.destroy()
    }
  })

test("p opens the new-project prompt and creates a second project", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: "data.db",
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openSettings(setup)
      await expandProject(setup)

      await pressKeys(setup, ["p"])
      await setup.waitForFrame(f => f.includes("new project"))
      await pressKeys(setup, ["w", "o", "r", "k"])
      await setup.waitForFrame(f => f.includes("work"))

      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("project added"))
      await setup.waitForFrame(f => f.includes("demo") && f.includes("work"))

      const projects = await Effect.runPromise(services.store.listProjects())
      expect(projects).toHaveLength(2)
      expect(projects.map(project => project.name).sort()).toEqual(["demo", "work"])
    } finally {
      setup.renderer.destroy()
    }
  })
})
