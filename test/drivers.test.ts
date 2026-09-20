import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import { MySqlContainer } from "@testcontainers/mysql"
import {
  connectPg,
  queryPg,
  disconnectPg,
  isConnectedPg,
  connectMysql,
  queryMysql,
  disconnectMysql,
  isConnectedMysql,
  connectSqlite,
  querySqlite,
  disconnectSqlite,
  isConnectedSqlite,
} from "@/drivers"
import { ConnectionError } from "@/drivers/types"
import { DatabaseDriver } from "@/drivers/database-driver"
import { dollarizeParams } from "@/drivers/pg"
import type { ActiveConnection, QueryResult } from "@/drivers/types"
import type { PostgresConnectionConfig, MysqlConnectionConfig, SqliteConnectionConfig } from "@/domain"

/*
 * Containers start once for the whole suite and stay up across all tests.
 * Ryuk auto-cleans on unexpected exits; a normal shutdown stops them.
 */
let pgContainer: Awaited<ReturnType<PostgreSqlContainer["start"]>> | undefined
let mysqlContainer: Awaited<ReturnType<MySqlContainer["start"]>> | undefined

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:17-alpine").start()
  mysqlContainer = await new MySqlContainer("mysql:8.4").start()
}, 120_000)

afterAll(async () => {
  await pgContainer?.stop()
  await mysqlContainer?.stop()
}, 120_000)

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

const sqliteConfig = (): SqliteConnectionConfig => ({
  engine: "sqlite",
  filename: `/tmp/dient-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
})

/* Run an Effect program inside a fresh scope and return its `Exit`. */
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromiseExit(Effect.scoped(effect))

/* Extract the success value or the failure cause from a covered Exit. */
const value = <A, E>(exit: Exit.Exit<A, E>): A => (exit as unknown as { value: A }).value

const cause = <A, E>(exit: Exit.Exit<A, E>): unknown => (exit as unknown as { cause: unknown }).cause

/* ---------------------------------------------------------------------------
 * Placeholder translation (pure)
 * ----------------------------------------------------------------------- */
describe("dollarizeParams", () => {
  it("rewrites every ? outside quotes to $1, $2, …", () => {
    expect(dollarizeParams(`UPDATE users SET name = ? WHERE id = ?`)).toBe(`UPDATE users SET name = $1 WHERE id = $2`)
  })

  it("leaves ? inside single-quoted strings and double-quoted identifiers alone", () => {
    const sql = `SELECT 'what?' AS q, "weird?name" = ? AS x`
    expect(dollarizeParams(sql)).toBe(`SELECT 'what?' AS q, "weird?name" = $1 AS x`)
  })

  it("ignores ? inside -- line comments", () => {
    const sql = `SELECT 1 -- is this ? ok\n, ? AS x`
    expect(dollarizeParams(sql)).toBe(`SELECT 1 -- is this ? ok\n, $1 AS x`)
  })
})

/* ---------------------------------------------------------------------------
 * PostgreSQL
 * ----------------------------------------------------------------------- */
describe("PostgreSQL driver", () => {
  it("connect returns an active connection", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const conn = yield* connectPg(pgConfig())
        yield* disconnectPg(conn)
        return conn
      })
    )
    expect(exit._tag).toBe("Success")
  })

  it("query returns rows with column metadata", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const conn = yield* connectPg(pgConfig())
        const result = yield* queryPg(conn, "SELECT 1 AS num, 'hello' AS msg")
        yield* disconnectPg(conn)
        return result
      })
    )
    expect(exit._tag).toBe("Success")
    const result = value(exit)
    expect(result.columns.map((c: any) => c.name)).toEqual(["num", "msg"])
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toEqual({ num: 1, msg: "hello" })
  })

  it("disconnect sets isConnected to false", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const conn = yield* connectPg(pgConfig())
        yield* disconnectPg(conn)
        return yield* isConnectedPg(conn)
      })
    )
    expect(exit._tag).toBe("Success")
    expect(value(exit)).toBe(false)
  })

  it("connection failure produces ConnectionError on wrong port", async () => {
    const exit = await run(connectPg({ ...pgConfig(), port: 1 }))
    expect(exit._tag).toBe("Failure")
    expect((cause(exit) as any)._tag).toBe("Fail")
    expect((cause(exit) as any).error).toBeInstanceOf(ConnectionError)
  })

  it("authentication failure produces ConnectionError", async () => {
    const exit = await run(connectPg({ ...pgConfig(), password: "definitely-wrong" }))
    expect(exit._tag).toBe("Failure")
    expect((cause(exit) as any)._tag).toBe("Fail")
    expect((cause(exit) as any).error).toBeInstanceOf(ConnectionError)
  })

  it("unreachable host times out with ConnectionError", async () => {
    const exit = await run(connectPg({ ...pgConfig(), host: "192.0.2.1", port: 5432 }))
    expect(exit._tag).toBe("Failure")
    expect((cause(exit) as any)._tag).toBe("Fail")
    expect((cause(exit) as any).error).toBeInstanceOf(ConnectionError)
  }, 15_000)

  it("connect + 1000-row query completes within budget", async () => {
    const table = `perf_test_${Date.now()}`
    const exit = await run(
      Effect.gen(function* () {
        const conn = yield* connectPg(pgConfig())
        yield* queryPg(conn, `CREATE TABLE ${table} (id int PRIMARY KEY, name text)`)
        yield* queryPg(conn, `INSERT INTO ${table} SELECT g, 'user_' || g FROM generate_series(1, 1000) g`)
        const t0 = performance.now()
        const result = yield* queryPg(conn, `SELECT * FROM ${table} ORDER BY id`)
        const elapsed = performance.now() - t0
        yield* queryPg(conn, `DROP TABLE ${table}`)
        yield* disconnectPg(conn)
        return { rows: result.rows.length, elapsed }
      })
    )
    expect(exit._tag).toBe("Success")
    expect(value(exit).rows).toBe(1000)
    expect(value(exit).elapsed).toBeLessThan(500)
  }, 15_000)
})

/* ---------------------------------------------------------------------------
 * MySQL
 * ----------------------------------------------------------------------- */
describe("MySQL driver", () => {
  it("connect returns an active connection", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const conn = yield* connectMysql(mysqlConfig())
        yield* disconnectMysql(conn)
        return conn
      })
    )
    expect(exit._tag).toBe("Success")
  })

  it("query returns rows with column metadata", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const conn = yield* connectMysql(mysqlConfig())
        const result = yield* queryMysql(conn, "SELECT 1 AS num, 'hello' AS msg")
        yield* disconnectMysql(conn)
        return result
      })
    )
    expect(exit._tag).toBe("Success")
    const result = value(exit)
    expect(result.columns.map((c: any) => c.name)).toEqual(["num", "msg"])
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toEqual({ num: 1, msg: "hello" })
  })

  it("disconnect sets isConnected to false", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const conn = yield* connectMysql(mysqlConfig())
        yield* disconnectMysql(conn)
        return yield* isConnectedMysql(conn)
      })
    )
    expect(exit._tag).toBe("Success")
    expect(value(exit)).toBe(false)
  })

  it("connection failure produces ConnectionError on wrong port", async () => {
    const exit = await run(connectMysql({ ...mysqlConfig(), port: 1 }))
    expect(exit._tag).toBe("Failure")
    expect((cause(exit) as any)._tag).toBe("Fail")
    expect((cause(exit) as any).error).toBeInstanceOf(ConnectionError)
  })

  it("authentication failure produces ConnectionError", async () => {
    const exit = await run(connectMysql({ ...mysqlConfig(), password: "definitely-wrong" }))
    expect(exit._tag).toBe("Failure")
    expect((cause(exit) as any)._tag).toBe("Fail")
    expect((cause(exit) as any).error).toBeInstanceOf(ConnectionError)
  })

  it("unreachable host times out with ConnectionError", async () => {
    const exit = await run(connectMysql({ ...mysqlConfig(), host: "192.0.2.1", port: 3306 }))
    expect(exit._tag).toBe("Failure")
    expect((cause(exit) as any)._tag).toBe("Fail")
    expect((cause(exit) as any).error).toBeInstanceOf(ConnectionError)
  }, 15_000)

  it("connect + 1000-row query completes within budget", async () => {
    const table = `perf_test_${Date.now()}`
    const exit = await run(
      Effect.gen(function* () {
        const conn = yield* connectMysql(mysqlConfig())
        yield* queryMysql(conn, `CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(64))`)
        yield* queryMysql(
          conn,
          `INSERT INTO ${table} (id, name)
         WITH RECURSIVE nums(n) AS (
           SELECT 1 UNION ALL SELECT n + 1 FROM nums WHERE n < 1000
         )
         SELECT n, CONCAT('user_', n) FROM nums`
        )
        const t0 = performance.now()
        const result = yield* queryMysql(conn, `SELECT * FROM ${table} ORDER BY id`)
        const elapsed = performance.now() - t0
        yield* queryMysql(conn, `DROP TABLE ${table}`)
        yield* disconnectMysql(conn)
        return { rows: result.rows.length, elapsed }
      })
    )
    expect(exit._tag).toBe("Success")
    expect(value(exit).rows).toBe(1000)
    expect(value(exit).elapsed).toBeLessThan(500)
  }, 30_000)
})

/* ---------------------------------------------------------------------------
 * SQLite
 * ----------------------------------------------------------------------- */
describe("SQLite driver", () => {
  it("connect returns an active connection", async () => {
    const config = sqliteConfig()
    const exit = await run(
      Effect.gen(function* () {
        const conn = yield* connectSqlite(config)
        yield* disconnectSqlite(conn)
        return conn
      })
    )
    expect(exit._tag).toBe("Success")
  })

  it("query returns rows with column metadata", async () => {
    const config = sqliteConfig()
    const exit = await run(
      Effect.gen(function* () {
        const conn = yield* connectSqlite(config)
        const result = yield* querySqlite(conn, "SELECT 1 AS num, 'hello' AS msg")
        yield* disconnectSqlite(conn)
        return result
      })
    )
    expect(exit._tag).toBe("Success")
    const result = value(exit)
    expect(result.columns.map((c: any) => c.name)).toEqual(["num", "msg"])
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toEqual({ num: 1, msg: "hello" })
  })

  it("disconnect sets isConnected to false", async () => {
    const config = sqliteConfig()
    const exit = await run(
      Effect.gen(function* () {
        const conn = yield* connectSqlite(config)
        yield* disconnectSqlite(conn)
        return yield* isConnectedSqlite(conn)
      })
    )
    expect(exit._tag).toBe("Success")
    expect(value(exit)).toBe(false)
  })

  it("connection failure produces ConnectionError on unwritable path", async () => {
    const exit = await run(connectSqlite({ engine: "sqlite", filename: "/definitely-not-writable/nope.db" }))
    expect(exit._tag).toBe("Failure")
    expect((cause(exit) as any)._tag).toBe("Fail")
    expect((cause(exit) as any).error).toBeInstanceOf(ConnectionError)
  })

  it("connect + 1000-row query completes within budget", async () => {
    const config = sqliteConfig()
    const exit = await run(
      Effect.gen(function* () {
        const conn = yield* connectSqlite(config)
        yield* querySqlite(conn, "CREATE TABLE perf_test (id INTEGER, name TEXT)")
        yield* querySqlite(
          conn,
          `
        WITH RECURSIVE nums(n) AS (
          SELECT 1 UNION ALL SELECT n + 1 FROM nums WHERE n < 1000
        )
        INSERT INTO perf_test SELECT n, 'user_' || n FROM nums
      `
        )
        const t0 = performance.now()
        const result = yield* querySqlite(conn, "SELECT * FROM perf_test")
        const elapsed = performance.now() - t0
        yield* disconnectSqlite(conn)
        return { rows: result.rows.length, elapsed }
      })
    )
    expect(exit._tag).toBe("Success")
    expect(value(exit).rows).toBe(1000)
    expect(value(exit).elapsed).toBeLessThan(500)
  }, 10_000)
})

/* ---------------------------------------------------------------------------
 * DatabaseDriver facade
 * ----------------------------------------------------------------------- */
describe("DatabaseDriver facade", () => {
  /* Run a program against the DatabaseDriver service (per-engine dispatch). */
  const runFacade = <A, E>(program: Effect.Effect<A, E, Scope.Scope | DatabaseDriver>) =>
    Effect.runPromiseExit(Effect.scoped(Effect.provide(program, DatabaseDriver.layer)))

  it("connect dispatches to the matching engine driver", async () => {
    const exit = await runFacade(
      Effect.gen(function* () {
        const driver = yield* DatabaseDriver
        const conn = yield* driver.connect(pgConfig())
        yield* driver.disconnect(conn)
        return conn
      })
    )
    expect(exit._tag).toBe("Success")
    expect(value(exit).engine).toBe("postgres")
  })

  it("query + isConnected work through the facade for every engine", async () => {
    const exit = await runFacade(
      Effect.gen(function* () {
        const driver = yield* DatabaseDriver
        const results: Record<string, QueryResult> = {}
        for (const config of [pgConfig(), mysqlConfig(), sqliteConfig()]) {
          const conn = yield* driver.connect(config)
          const result = yield* driver.query(conn, "SELECT 1 AS one")
          results[config.engine] = result
          const healthy = yield* driver.isConnected(conn)
          expect(healthy).toBe(true)
          yield* driver.disconnect(conn)
        }
        return results
      })
    )
    expect(exit._tag).toBe("Success")
    const results = value(exit)
    for (const engine of Object.keys(results)) {
      expect(results[engine as "postgres" | "mysql" | "sqlite"]!.columns[0]!.name).toBe("one")
    }
  })

  it("surfaces ConnectionError for a failing engine through the facade", async () => {
    const exit = await runFacade(
      Effect.gen(function* () {
        const driver = yield* DatabaseDriver
        yield* driver.connect({ ...pgConfig(), port: 1 })
      })
    )
    expect(exit._tag).toBe("Failure")
    expect((cause(exit) as any).error).toBeInstanceOf(ConnectionError)
  })
})
