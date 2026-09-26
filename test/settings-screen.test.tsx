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
import { pressKeys, renderApp, typeString } from "@test/support/render-ui"
import { freshConfigFile, freshSqliteDataFile, resolveTestServices, seedProject } from "@test/support/services-fixture"

/* Navigate to the settings screen through the `:` command line. */
async function openSettings(setup: Awaited<ReturnType<typeof renderApp>>) {
  await pressKeys(setup, [":", "s", "e", "t", "t", "i", "n", "g", "s", "RETURN"])
  await setup.waitForFrame(f => f.includes("SETTINGS"))
}

const frameText = (setup: Awaited<ReturnType<typeof renderApp>>): string =>
  setup
    .captureSpans()
    .lines.map(line => line.spans.map(span => span.text).join(""))
    .join("\n")

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

      /* cursor is on the database; a offers paste-vs-fields, 1 pastes a string */
      await pressKeys(setup, ["a"])
      await setup.waitForFrame(f => f.includes("Enter open"))
      await pressKeys(setup, ["1"])
      await setup.waitForFrame(f => f.includes("connection string: "))

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
      await setup.waitForFrame(f => f.includes("Enter open"))
      await pressKeys(setup, ["1"])
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

  /* The mode contract, stated as a test: while a text field is open it is the
     sole keyboard owner, so *every* character NORMAL mode binds must type as
     text. This is the guard against the class of bug where one more binding
     (`:` for the command line, `?` for help, `u`, `/`) quietly eats a
     character of a connection string. */
  test("every NORMAL-mode binding types as text while a form is open", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: "data.db",
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    const draft = (): string => {
      const match = /new database · connection string: ([^▍]*)/.exec(setup.captureCharFrame())
      return match?.[1] ?? ""
    }
    try {
      await openSettings(setup)
      await expandProject(setup)
      await pressKeys(setup, ["a"])
      await setup.waitForFrame(f => f.includes("Enter open"))
      await pressKeys(setup, ["1"])
      await setup.waitForFrame(f => f.includes("connection string: "))

      /* a p d t r e s g G v i j k h l w b m n x ? : / space - the union of
         NORMAL bindings this screen and the explorer declare. */
      const keys = [
        "a", "p", "d", "t", "r", "e", "s", "g", "G", "v", "i", "j", "k", "h", "l", "w", "b", "m", "n", "x",
        "?", ":", "/", " ",
      ]
      for (const key of keys) await pressKeys(setup, [key])
      expect(draft()).toBe(keys.join(""))
    } finally {
      setup.renderer.destroy()
    }
  })

  /* Same contract for the other INSERT surfaces: the finder query, `/` search,
     and a cell value are all text fields, so they must take these keys too. */
  test("the finder query takes characters the NORMAL mode binds", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: "data.db",
    })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, [" "])
      await setup.waitForFrame(f => f.includes("matches"))
      await pressKeys(setup, [":", "?", "j", "k", "/", "d", "t"])
      /* The query is text: the finder narrowed instead of the screen jumping,
         and no app-level shortcut (command line / help) stole a keystroke. */
      await setup.waitForFrame(f => f.includes(":?jk/dt"))
      const frame = setup.captureCharFrame()
      expect(frame).toContain(":?jk/dt")
      expect(frame).not.toContain("flush pending changes")
      expect(frame).not.toContain("BINDINGS")
    } finally {
      setup.renderer.destroy()
    }
  })

  /* A pasted connection string is mostly characters NORMAL mode claims as
     bindings: `u` (the engine toggle), `e`, `?`, and shifted symbols like `@`
     and `_` that a kitty-mode terminal reports as their unshifted base key
     (`2`, `-`) plus a shift flag. The form must receive the string verbatim. */
  test("a connection string with binding letters and shifted symbols types verbatim", async () => {
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
      await setup.waitForFrame(f => f.includes("Enter open"))
      await pressKeys(setup, ["1"])
      await setup.waitForFrame(f => f.includes("connection string: "))

      await typeString(setup, "mysql://root:gameroot@localhost:3309/game_service")
      /* A kitty-mode terminal reports `@` as `2` and `_` as `-`; if the form
         typed the raw key name, the visible prefix would read `2gameroot`.
         The prompt line clips at the frame width, so assert on the head. */
      await setup.waitForFrame(f => f.includes("mysql://root:gameroot"))
      expect(setup.captureCharFrame()).not.toContain("2gameroot")
      /* The engine toggle must not have fired on any `u` in the string. */
      expect(setup.captureCharFrame()).toContain("connection string")

      await pressKeys(setup, ["RETURN"])
      /* Submitting parses the draft, so a verbatim string is the only way to
         get these exact values back out of the config store. */
      await setup.waitForFrame(f => f.includes("game_service") && f.includes("added"))
      expect(setup.captureCharFrame()).not.toContain("2gameroot")

      const databases = await Effect.runPromise(services.store.listDatabases(seeded.project.id))
      const added = databases.find(database => database.name === "game_service")
      expect(added).toBeDefined()
      expect(added?.engine).toBe("mysql")
      const connections = added ? await Effect.runPromise(services.store.listConnections(added.id)) : []
      expect(connections[0]?.host).toBe("localhost")
      expect(connections[0]?.port).toBe(3309)
      expect(connections[0]?.user).toBe("root")
      expect(connections[0]?.password).toBe("gameroot")
    } finally {
      setup.renderer.destroy()
    }
  })

  /* `:` and `?` are app-level shortcuts, and both are load-bearing in a
     connection string. A terminal in legacy mode reports them as literal key
     names (`e.name === ":"`), which is exactly what the global handler
     matches on; a kitty-mode terminal reports `:` as `;` plus shift. Both must
     land in the form, and neither may open the command line or help. */
  test("a colon or question mark in the connection string does not trigger a global shortcut", async () => {
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
      await setup.waitForFrame(f => f.includes("Enter open"))
      await pressKeys(setup, ["1"])
      await setup.waitForFrame(f => f.includes("connection string: "))

      /* Legacy reporting: `:` and `?` arrive as themselves. */
      await pressKeys(setup, ["m", "y", "s", "q", "l", ":", "/", "/"])
      await setup.waitForFrame(f => f.includes("connection string: mysql://"))
      /* The command bar is the tell-tale: it only renders when it is open. */
      expect(setup.captureCharFrame()).not.toContain("flush pending changes")
      expect(setup.captureCharFrame()).not.toContain("BINDINGS")

      /* `?` opens the help overlay, which also renders only when open. */
      await pressKeys(setup, ["?"])
      await setup.waitForFrame(f => f.includes("connection string: mysql://?"))
      expect(setup.captureCharFrame()).not.toContain("BINDINGS")
      await pressKeys(setup, ["BACKSPACE"])

      /* Finish it as a real url and submit: the `?` query and the credentials
         can only survive if every keystroke reached the form. */
      await typeString(setup, "root:pw@localhost:3306/shop?ssl=true")
      await setup.waitForFrame(f => f.includes("localhost:3306/shop?ssl=true"))
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("added shop"))

      const databases = await Effect.runPromise(services.store.listDatabases(seeded.project.id))
      const added = databases.find(database => database.name === "shop")
      expect(added).toBeDefined()
      expect(added?.engine).toBe("mysql")
      const connections = added ? await Effect.runPromise(services.store.listConnections(added.id)) : []
      expect(connections[0]?.user).toBe("root")
      expect(connections[0]?.host).toBe("localhost")
      expect(connections[0]?.port).toBe(3306)
    } finally {
      setup.renderer.destroy()
    }
  })

  /* The details form is the other half of every DB client's "new connection"
     dialog: name, host, port, user, password, database. */
  test("option 2 adds a database from host / port / user / password fields", async () => {
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
      await setup.waitForFrame(f => f.includes("host / user / password"))
      await pressKeys(setup, ["2"])
      await setup.waitForFrame(f => f.includes("name:"))

      for (const value of ["shop", "db.internal", "5432", "admin", "s3cret", "orders"]) {
        await typeString(setup, value)
        await pressKeys(setup, ["TAB"])
      }
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("added shop"))

      const databases = await Effect.runPromise(services.store.listDatabases(seeded.project.id))
      const added = databases.find(database => database.name === "shop")
      expect(added).toBeDefined()
      const connections = added ? await Effect.runPromise(services.store.listConnections(added.id)) : []
      expect(connections[0]?.host).toBe("db.internal")
      expect(connections[0]?.port).toBe(5432)
      expect(connections[0]?.user).toBe("admin")
      expect(connections[0]?.password).toBe("s3cret")
      expect(connections[0]?.defaultDatabase).toBe("orders")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("uppercase letters in a typed value keep their case", async () => {
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

      /* A credentials field is where a capitalised password actually breaks. */
      await pressKeys(setup, ["a"])
      await setup.waitForFrame(f => f.includes("host / user / password"))
      await pressKeys(setup, ["2"])
      await setup.waitForFrame(f => f.includes("name:"))

      await typeString(setup, "S3cret!Pass")
      await setup.waitForFrame(f => f.includes("S3cret!Pass"))
    } finally {
      setup.renderer.destroy()
    }
  })
})

describe("adding a connection reveals it", () => {
  /* A report worth pinning: "a connection was added but the TUI shows
     nothing". The cause was that databases are only listed under an *expanded*
     project, so a create under a collapsed project reported success while
     rendering no row at all. The add must reveal its own result. */
  test("a real mysql URL appears in the tree without manual expanding", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: "data.db" })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openSettings(setup)
      await pressKeys(setup, ["a"])
      await setup.waitForFrame(f => f.includes("Enter open"))
      await pressKeys(setup, ["1"])
      await setup.waitForFrame(f => f.includes("connection string: "))
      await typeString(setup, "mysql://root:gameroot@localhost:3309/game_service")
      await pressKeys(setup, ["RETURN"])

      /* Expanded, listed, and carrying the parsed connection. */
      await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("game_service"))
      expect(frameText(setup)).toContain("mysql")
      expect(frameText(setup)).toContain("root@localhost:3309")
    } finally {
      setup.renderer.destroy()
    }
  })

  /* The choice menu is a menu, not a prompt line: it has to be navigable. */
  test("the add menu navigates with j/k and opens with Enter", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: "data.db" })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openSettings(setup)
      await pressKeys(setup, ["a"])
      await setup.waitForFrame(f => f.includes("Enter open"))
      expect(frameText(setup)).toContain("▸ paste connection string")

      /* j moves the highlight to the details form... */
      await pressKeys(setup, ["j"])
      await setup.waitForFrame(f => f.includes("▸ host / user / password"))
      /* ...j clamps at the end, and Enter opens the highlighted choice. */
      await pressKeys(setup, ["j"])
      await setup.waitForFrame(f => f.includes("▸ host / user / password"))
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("name: "))
    } finally {
      setup.renderer.destroy()
    }
  })
  /* "insert mode" has to be visible, not merely implemented. */
  test("the status bar reads INSERT while a field owns the keyboard", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: "data.db" })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openSettings(setup)
      expect(frameText(setup)).toContain("NORMAL")

      await pressKeys(setup, ["a"])
      await setup.waitForFrame(f => f.includes("Enter open"))
      expect(frameText(setup)).toContain("INSERT")

      await pressKeys(setup, ["ESCAPE"])
      await setup.waitForFrame(f => !f.includes("Enter open"))
      expect(frameText(setup)).toContain("NORMAL")
    } finally {
      setup.renderer.destroy()
    }
  })
})
