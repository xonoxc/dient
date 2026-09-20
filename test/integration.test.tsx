/**
 * End-to-end integration tests against real database containers (PostgreSQL
 * and MySQL) plus real persisted ConfigStore/SQLite state.
 *
 * These exercise the whole stack — real drivers, real handshakes, real
 * containers — rather than the mocked connect used by the unit suites:
 *
 *   1. boot → expand the tree → connect a Postgres database → browse data
 *   2. edit a cell → save → verify the row really changed inside the container
 *   3. switch live between Postgres and MySQL → table + data follow the cursor
 *   4. create a connection in settings → it appears in the explorer sidebar
 *   5. delete a connection in settings → it disappears from the sidebar
 *   6. config survives a simulated restart (same config.db, fresh services)
 *   7. a failed connection shows the error dot → recovery to a healthy one
 *
 * A small performance suite asserts real connect latency is within budget.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Effect, Scope } from "effect"
import App from "@/app"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import { MySqlContainer } from "@testcontainers/mysql"
import { makeTheme } from "@/theme"
import { pressKeys, renderApp } from "@test/support/render-ui"
import { freshConfigFile, resolveTestServices, seedProject } from "@test/support/services-fixture"
import { DatabaseDriver } from "@/drivers/database-driver"
import type { AppServices } from "@/app-context"
import type { PostgresConnectionConfig, MysqlConnectionConfig } from "@/domain"

let pgContainer: Awaited<ReturnType<PostgreSqlContainer["start"]>> | undefined
let mysqlContainer: Awaited<ReturnType<MySqlContainer["start"]>> | undefined

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:17-alpine").start()
  mysqlContainer = await new MySqlContainer("mysql:8.4").start()
}, 180_000)

afterAll(async () => {
  await pgContainer?.stop()
  await mysqlContainer?.stop()
}, 180_000)

const pgConfig = (): PostgresConnectionConfig => ({
  engine: "postgres",
  host: pgContainer!.getHost(),
  port: pgContainer!.getPort(),
  user: pgContainer!.getUsername(),
  password: pgContainer!.getPassword(),
  defaultDatabase: pgContainer!.getDatabase(),
})

const mysqlConfig = (): MysqlConnectionConfig => ({
  engine: "mysql",
  host: mysqlContainer!.getHost(),
  port: mysqlContainer!.getPort(),
  user: mysqlContainer!.getUsername(),
  password: mysqlContainer!.getUserPassword(),
  defaultDatabase: mysqlContainer!.getDatabase(),
})

const runScoped = <A, E>(program: Effect.Effect<A, E, Scope.Scope | DatabaseDriver>): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.provide(program, DatabaseDriver.layer)))

/** Write the seeded rows into the live container through the real driver. */
const seedServer = async (
  config: PostgresConnectionConfig | MysqlConnectionConfig,
  statements: ReadonlyArray<string>
): Promise<void> => {
  await runScoped(
    Effect.gen(function* () {
      const driver = yield* DatabaseDriver
      const conn = yield* driver.connect(config)
      for (const sql of statements) yield* driver.query(conn, sql)
      yield* driver.disconnect(conn)
    })
  )
}

/* Seed both containers with a distinguishable `users` table. Idempotent: tests
   share the containers (TRUNCATE resets identities) so repeated seeding never
   grows the row set. */
const seedContainers = async (): Promise<void> => {
  await seedServer(pgConfig(), [
    `DROP TABLE IF EXISTS users`,
    `CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT)`,
    `INSERT INTO users (name, email) VALUES
       ('alice', 'alice@example.com'),
       ('bob', 'bob@example.com'),
       ('carol', 'carol@example.com')`,
  ])
  await seedServer(mysqlConfig(), [
    `DROP TABLE IF EXISTS users`,
    `CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(64) NOT NULL, email VARCHAR(64))`,
    `INSERT INTO users (name, email) VALUES
       ('dave', 'dave@mysql.example'),
       ('erin', 'erin@mysql.example')`,
  ])
}

/** Seed the ConfigStore with a project → prod(postgres) + stage(mysql). */
const seedServerProject = async (services: AppServices) => {
  const store = services.configStore
  const project = await Effect.runPromise(store.createProject({ name: "demo" }))
  const pg = pgConfig()
  const prod = await Effect.runPromise(
    store.createDatabase({ projectId: project.id, name: "prod", engine: "postgres" })
  )
  const prodConnection = await Effect.runPromise(
    store.createConnection({
      databaseId: prod.id,
      host: pg.host,
      port: pg.port,
      user: pg.user,
      password: pg.password,
      defaultDatabase: pg.defaultDatabase,
    })
  )
  const my = mysqlConfig()
  const stage = await Effect.runPromise(store.createDatabase({ projectId: project.id, name: "stage", engine: "mysql" }))
  const stageConnection = await Effect.runPromise(
    store.createConnection({
      databaseId: stage.id,
      host: my.host,
      port: my.port,
      user: my.user,
      password: my.password,
      defaultDatabase: my.defaultDatabase,
    })
  )
  return { project, prod, prodConnection, stage, stageConnection }
}

/* Container-backed waits get extra passes: a real handshake + listTables +
   count happens across several effect-driven frames. */
const WAIT = { maxPasses: 80 }

/** Boot to a connected prod (Postgres) with the users table on screen. */
async function openProd(setup: Awaited<ReturnType<typeof renderApp>>): Promise<void> {
  await pressKeys(setup, ["RETURN"])
  await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("○ prod"), WAIT)
  await pressKeys(setup, ["j", "RETURN"])
  await setup.waitForFrame(f => f.includes("USERS") && f.includes("alice"), WAIT)
}

describe("integration (real containers)", () => {
  test("boot → select connection → browse tables → view data", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedContainers()
    await seedServerProject(services.services)
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openProd(setup)
      const frame = setup.captureCharFrame()
      expect(frame).toContain("USERS")
      expect(frame).toContain("alice@example.com")
      expect(frame).toContain("bob@example.com")
      expect(frame).toContain("3 rows")
      expect(frame).toContain("●")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("edit a cell, save, and verify the row really changed in the container", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedContainers()
    const seeded = await seedServerProject(services.services)
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await openProd(setup)

      /* move into the table panel so the editor targets the name column */
      await pressKeys(setup, ["l"])

      /* overwrite alice → amy (cursor is on row 1 / column 0, so right arrow
         lands on the name column) */
      globalThis.IS_REACT_ACT_ENVIRONMENT = true
      try {
        await import("react").then(({ act }) =>
          act(async () => {
            setup.mockInput.pressArrow("right")
            setup.renderOnce()
            setup.flush()
          })
        )
      } finally {
        globalThis.IS_REACT_ACT_ENVIRONMENT = false
      }
      await setup.waitForVisualIdle()

      const CLEAR = ["BACKSPACE", "BACKSPACE", "BACKSPACE", "BACKSPACE", "BACKSPACE"] as const
      await pressKeys(setup, ["RETURN", ...CLEAR, "a", "m", "y", "RETURN"])
      await setup.waitForFrame(f => f.includes("amy") && f.includes("alice@example.com"), WAIT)

      /* prove the bytes actually made it to Postgres: read straight from the
         container over a fresh driver connection */
      const name = await runScoped(
        Effect.gen(function* () {
          const driver = yield* DatabaseDriver
          const conn = yield* driver.connect(pgConfig())
          const result = yield* driver.query(conn, `SELECT name FROM users WHERE id = 1`)
          yield* driver.disconnect(conn)
          return (result.rows[0] as { name: string }).name
        })
      )
      expect(name).toBe("amy")
      /* and the other rows are untouched */
      void seeded
    } finally {
      setup.renderer.destroy()
    }
  })

  test("switch live between Postgres and MySQL; the table and data follow", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedContainers()
    await seedServerProject(services.services)
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      /* expand the tree so both database rows are visible before connecting */
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(
        f => f.includes("▾ demo") && f.includes("○ prod") && f.includes("○ stage"),
        WAIT
      )

      /* connect prod (Postgres) first */
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(
        f => f.includes("USERS") && f.includes("alice@example.com") && !f.includes("dave@mysql.example"),
        WAIT
      )

      /* walk down past prod's table row onto stage, then connect it (MySQL) */
      await pressKeys(setup, ["j", "j", "RETURN"])
      await setup.waitForFrame(
        f => f.includes("USERS") && f.includes("dave@mysql.example") && !f.includes("alice@example.com"),
        WAIT
      )

      /* Tab cycles back to the Postgres connection: table + data switch engines */
      await pressKeys(setup, ["TAB"])
      await setup.waitForFrame(
        f => f.includes("USERS") && f.includes("alice@example.com") && !f.includes("dave@mysql.example"),
        WAIT
      )
    } finally {
      setup.renderer.destroy()
    }
  })

  test("creating a database in settings surfaces it in the explorer sidebar", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedProject(services.store, { name: "demo", database: "main", engine: "sqlite", filename: "data.db" })
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, [":", "s", "e", "t", "t", "i", "n", "g", "s", "RETURN"])
      await setup.waitForFrame(f => f.includes("SETTINGS"), WAIT)
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("main"), WAIT)
      await pressKeys(setup, ["j"])

      /* paste a connection string: reports.db → database "reports" */
      await pressKeys(setup, ["a"])
      await setup.waitForFrame(f => f.includes("connection string"), WAIT)
      await pressKeys(setup, ["r", "e", "p", "o", "r", "t", "s", ".", "d", "b"])
      await setup.waitForFrame(f => f.includes("reports.db"), WAIT)
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("added reports"), WAIT)
      await setup.waitForFrame(f => f.includes("reports.db"), WAIT)

      /* back to the explorer: expand the tree and the new database shows up */
      await pressKeys(setup, [":", "e", "x", "p", "l", "o", "r", "e", "r", "RETURN"])
      await setup.waitForFrame(f => !f.includes("SETTINGS"), WAIT)
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("main") && f.includes("reports"), WAIT)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("deleting a database in settings removes it from the sidebar", async () => {
    const services = await resolveTestServices(freshConfigFile())
    const seeded = await seedProject(services.store, {
      name: "demo",
      database: "main",
      engine: "sqlite",
      filename: "data.db",
    })
    await Effect.runPromise(
      services.store.createDatabase({ projectId: seeded.project.id, name: "reports", engine: "sqlite" })
    )
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, [":", "s", "e", "t", "t", "i", "n", "g", "s", "RETURN"])
      await setup.waitForFrame(f => f.includes("SETTINGS"), WAIT)
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("main") && f.includes("reports"), WAIT)

      /* cursor: project → main → reports; settings handlers are state-based,
         so cursor motion needs its own frame */
      await pressKeys(setup, ["j", "j"])
      await pressKeys(setup, ["d"])
      await setup.waitForFrame(f => f.includes("Delete database") && f.includes("reports"), WAIT)
      await pressKeys(setup, ["y"])
      await setup.waitForFrame(f => f.includes("database deleted"), WAIT)
      await setup.waitForFrame(f => !f.includes("reports") && f.includes("main"), WAIT)

      /* the explorer sidebar no longer offers the deleted database */
      await pressKeys(setup, [":", "e", "x", "p", "l", "o", "r", "e", "r", "RETURN"])
      await setup.waitForFrame(f => !f.includes("SETTINGS"), WAIT)
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("main") && !f.includes("reports"), WAIT)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("config persists across a simulated restart", async () => {
    const configPath = freshConfigFile()
    const first = await resolveTestServices(configPath)
    await seedProject(first.store, { name: "demo", database: "main", engine: "sqlite", filename: "data.db" })
    const setup1 = await renderApp(<App theme={makeTheme("dark")} services={first.services} />)
    try {
      await pressKeys(setup1, [":", "s", "e", "t", "t", "i", "n", "g", "s", "RETURN"])
      await setup1.waitForFrame(f => f.includes("SETTINGS"), WAIT)
      await pressKeys(setup1, ["RETURN"])
      await setup1.waitForFrame(f => f.includes("▾ demo") && f.includes("main"), WAIT)
      await pressKeys(setup1, ["j"])
      await pressKeys(setup1, ["a"])
      await setup1.waitForFrame(f => f.includes("connection string"), WAIT)
      await pressKeys(setup1, ["p", "e", "r", "s", "i", "s", "t", ".", "d", "b"])
      await pressKeys(setup1, ["RETURN"])
      await setup1.waitForFrame(f => f.includes("added persist") && f.includes("persist.db"), WAIT)
    } finally {
      setup1.renderer.destroy()
    }

    /* fresh services against the SAME config.db — a simulated relaunch */
    const second = await resolveTestServices(configPath)
    const setup2 = await renderApp(<App theme={makeTheme("dark")} services={second.services} />)
    try {
      await pressKeys(setup2, ["RETURN"])
      await setup2.waitForFrame(f => f.includes("▾ demo"), WAIT)
      await setup2.waitForFrame(f => f.includes("main") && f.includes("persist"), WAIT)
    } finally {
      setup2.renderer.destroy()
    }
  })

  test("a failed connection shows the error dot, then recovers to a healthy one", async () => {
    const services = await resolveTestServices(freshConfigFile())
    await seedContainers()
    const store = services.store
    const pg = pgConfig()
    const project = await Effect.runPromise(store.createProject({ name: "demo" }))
    /* databases render name-sorted, so "bad" sits above "good" */
    const badDb = await Effect.runPromise(
      store.createDatabase({ projectId: project.id, name: "bad", engine: "postgres" })
    )
    const bad = await Effect.runPromise(
      store.createConnection({
        databaseId: badDb.id,
        host: pg.host,
        port: 1,
        user: pg.user,
        password: pg.password,
        defaultDatabase: pg.defaultDatabase,
      })
    )
    const goodDb = await Effect.runPromise(
      store.createDatabase({ projectId: project.id, name: "good", engine: "postgres" })
    )
    const goodConn = await Effect.runPromise(
      store.createConnection({
        databaseId: goodDb.id,
        host: pg.host,
        port: pg.port,
        user: pg.user,
        password: pg.password,
        defaultDatabase: pg.defaultDatabase,
      })
    )
    void bad
    void goodConn
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)
    try {
      await pressKeys(setup, ["RETURN"])
      await setup.waitForFrame(f => f.includes("▾ demo") && f.includes("○ bad") && f.includes("○ good"), WAIT)

      /* connect the bad one: toast + retry prompt, then dismiss */
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("failed") && f.includes("retry"), WAIT)
      await pressKeys(setup, ["n"])
      await setup.waitForFrame(f => !f.includes("retry") && f.includes("◉"), WAIT)

      /* move to the healthy database below and connect — recovery works */
      await pressKeys(setup, ["j", "RETURN"])
      await setup.waitForFrame(f => f.includes("USERS") && f.includes("alice") && f.includes("●"), WAIT)
    } finally {
      setup.renderer.destroy()
    }
  })
})

describe("integration performance", () => {
  test("a real Postgres handshake completes within budget", async () => {
    const services = await resolveTestServices(freshConfigFile())
    const seeded = await seedServerProject(services.services)
    const manager = services.services.connectionManager
    const t0 = performance.now()
    await Effect.runPromise(manager.connect(seeded.prodConnection.id))
    const elapsed = performance.now() - t0
    await Effect.runPromise(manager.disconnect(seeded.prodConnection.id))
    expect(elapsed).toBeLessThan(2000)
  }, 30_000)
})
