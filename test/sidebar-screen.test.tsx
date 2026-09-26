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
import { Database as SqliteDatabase } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { freshConfigFile, freshSqliteDataFile, resolveTestServices, seedProject } from "@test/support/services-fixture"
import { fitLabel } from "@/sidebar/fit-label"

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

describe("sidebar labels", () => {
  /* Reproduces a real schema: names long enough to overrun the panel used to
     render as blank rows, which read as a glitch rather than as a long name. */
  const LONG_TABLES = [
    "Aggregators",
    "Category",
    "GameCategory",
    "GameSessions",
    "Games",
    "ProviderRestrictedCountry",
    "ProviderUserMapping",
    "Providers",
    "SequelizeMeta",
    "UserFavouriteGames",
    "UserRecentGames",
  ]

  test("a table name that exactly fills the row is still drawn", async () => {
    /* `ProviderRestrictedCountry` is 25 characters, which was exactly the
       label budget for a depth-2 table. A row that fills the panel is measured
       at zero columns and drew *nothing* — the name opened its table correctly
       but showed as a blank sidebar row. Asserting only that `fitLabel`
       returned a non-empty string missed this entirely: the function handed
       back the full 25 characters and the renderer threw them away. This
       checks the rendered panel. */
    const path = join(mkdtempSync(join(tmpdir(), "dient-sidebar-")), "game.db")
    const db = new SqliteDatabase(path)
    for (const name of LONG_TABLES) db.run(`CREATE TABLE "${name}" (id INTEGER PRIMARY KEY)`)
    db.close()

    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "work", database: "game_service", engine: "sqlite", filename: path })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ work"))
      /* Connecting lists the tables as sidebar leaves. */
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("game_service") && f.includes("Aggregators"))

      const sidebarColumn = setup
        .captureCharFrame()
        .split("\n")
        .map(line => line.slice(0, 32))
        .join("\n")

      /* Every name is either shown in full or clipped with a visible ellipsis —
         never a row that is simply blank. */
      for (const name of LONG_TABLES) {
        const row = sidebarColumn.split("\n").find(line => line.includes(name.slice(0, 12)))
        expect(row).toBeDefined()
        expect(row!.trim()).not.toBe("▸")
        expect(row).toContain("▸ ")
      }
      /* The name that started this is visibly clipped, not dropped. */
      expect(sidebarColumn).toContain("ProviderRestricted")
    } finally {
      setup.renderer.destroy()
    }
  })
})
