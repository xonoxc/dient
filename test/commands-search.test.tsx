/**
 * Commands + search screen tests. `:` opens the command line and executes
 * shell/explorer commands (`:e <table>`, `:refresh`, `:connect <db>`,
 * unknown-command errors); `/` opens search, filters rows, hops with n/N, and
 * highlights the matching substring.
 */
import { describe, expect, test } from "bun:test"
import { Database as SqliteDatabase } from "bun:sqlite"
import { Effect } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import App from "@/app"
import { makeTheme } from "@/theme"
import { pressKeys, renderApp } from "@test/support/render-ui"
import { splitHighlighted } from "@/table/data-table"
import {
  freshConfigFile,
  freshSqliteDataFile,
  resolveTestServices,
  seedProject,
} from "@test/support/services-fixture"

/** A sqlite file at a distinctive basename so connections can be told apart
    in the sidebar (the shared fixture always names its file "data.db"). */
function namedDataFile(basename: string, rows: ReadonlyArray<Record<string, unknown>> = [{ id: 9, name: "zed", email: "zed@example.com" }]): string {
  const path = join(mkdtempSync(join(tmpdir(), "dient-data-")), basename)
  const db = new SqliteDatabase(path)
  db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)")
  const insert = db.prepare("INSERT INTO users (id, name, email) VALUES (?, ?, ?)")
  for (const row of rows) insert.run(row.id as number, row.name as string, row.email as string)
  db.close()
  return path
}

async function connect(setup: Awaited<ReturnType<typeof renderApp>>) {
  await pressKeys(setup, ["RETURN"])
  await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("▸ main"))
  await pressKeys(setup, ["j", "RETURN"])
  await setup.waitForFrame(f => f.includes("○ data.db"))
  await pressKeys(setup, ["j", "RETURN"])
  await setup.waitForFrame(f => f.includes("USERS") && f.includes("alice"))
  await pressKeys(setup, ["l"])
}

describe("command line", () => {
  test(": opens the command palette with help text", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store)
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, [":"])
      await setup.waitForFrame(f => f.includes(":") && f.includes(":e <table>"))
      expect(setup.captureCharFrame()).toContain(":e <table>")
      await pressKeys(setup, ["ESCAPE"])
    } finally {
      setup.renderer.destroy()
    }
  })

  test(":e <table> opens a table without touching the sidebar", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store)
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await connect(setup)
      await pressKeys(setup, [":", "e", " ", "u", "s", "e", "r", "s", "RETURN"])
      await setup.waitForFrame(f => f.includes("▶ USERS") && f.includes("alice"))
      expect(setup.captureCharFrame()).toContain("alice@example.com")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("unknown commands toast an error instead of crashing", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store)
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, [":", "f", "r", "o", "b", "n", "i", "c", "a", "t", "e", "RETURN"])
      await setup.waitForFrame(f => f.includes("unknown command: frobnicate"))
    } finally {
      setup.renderer.destroy()
    }
  })

  test(":refresh with no table open explains itself", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store)
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, [":", "r", "e", "f", "r", "e", "s", "h", "RETURN"])
      await setup.waitForFrame(f => f.includes("no table open to refresh"))
    } finally {
      setup.renderer.destroy()
    }
  })

  test(":connect <name> switches the active connection", async () => {
    const services = await resolveTestServices(freshConfigFile())
    /* one project, one database, two connections with distinct file names */
    const project = await Effect.runPromise(services.store.createProject({ name: "demo" }))
    const main = await Effect.runPromise(
      services.store.createDatabase({ projectId: project.id, name: "main", engine: "sqlite" })
    )
    await Effect.runPromise(
      services.store.createConnection({ databaseId: main.id, filename: namedDataFile("a.db") })
    )
    await Effect.runPromise(
      services.store.createConnection({
        databaseId: main.id,
        filename: namedDataFile("b.db", [
          { id: 1, name: "alice", email: "alice@example.com" },
          { id: 2, name: "bob", email: "bob@example.com" },
        ]),
      })
    )
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      /* expand project → database, then connect to the first listed (a.db) */
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("▸ main"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("○ a.db") && f.includes("○ b.db"))
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("● a.db") && f.includes("USERS") && f.includes("zed"))
      await pressKeys(setup, ["l"])

      await pressKeys(setup, [":", "c", "o", "n", "n", "e", "c", "t", " ", "b", ".", "d", "b", "RETURN"])
      await setup.waitForFrame(f => f.includes("● b.db") && f.includes("alice@example.com"))
      const frame = setup.captureCharFrame()
      expect(frame).toContain("alice")
      expect(frame).not.toContain("zed@example.com")
    } finally {
      setup.renderer.destroy()
    }
  })
})

describe("search", () => {
  test("/ filters rows to matches and shows the count", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store)
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await connect(setup)
      await pressKeys(setup, ["/", "b", "o", "b", "RETURN"])
      await setup.waitForFrame(f => f.includes("bob@example.com") && f.includes("1 matches"))
      const frame = setup.captureCharFrame()
      expect(frame).toContain("bob@example.com")
      expect(frame).not.toContain("carol")
      expect(frame).not.toContain("alice@example.com")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("n/N hop between matches while the filter is active", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store)
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await connect(setup)
      /* every row matches @example.com, so n hops to the next row */
      await pressKeys(setup, ["/", "@", "e", "x", "a", "m", "p", "l", "e", "RETURN"])
      await setup.waitForFrame(f => f.includes("3 matches"))
      await pressKeys(setup, ["n"])
      await setup.waitForFrame(f => f.includes("▶2"))
      expect(setup.captureCharFrame()).toContain("▶2")
      await pressKeys(setup, ["N"])
      await setup.waitForFrame(f => f.includes("▶1"))
    } finally {
      setup.renderer.destroy()
    }
  })

  test("Escape clears the filter and restores all rows", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store)
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await connect(setup)
      await pressKeys(setup, ["/", "b", "o", "ESCAPE"])
      await setup.waitForFrame(f => f.includes("carol"))
      expect(setup.captureCharFrame()).toContain("alice@example.com")
    } finally {
      setup.renderer.destroy()
    }
  })
})

describe("splitHighlighted", () => {
  test("splits around the match so it can be tinted", () => {
    expect(splitHighlighted("alice@example.com", "ample")).toEqual([
      { text: "alice@ex", matched: false },
      { text: "ample", matched: true },
      { text: ".com", matched: false },
    ])
  })

  test("no match returns the whole text plain", () => {
    expect(splitHighlighted("bob", "zed")).toEqual([{ text: "bob", matched: false }])
  })
})