import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { Effect, Exit, Option, Scope } from "effect"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import { MySqlContainer } from "@testcontainers/mysql"
import { DatabaseDriver } from "@/drivers/database-driver"
import { SchemaInspector } from "@/inspector"
import type { SchemaInspectorService, TableInfo } from "@/inspector"
import type { ActiveConnection, QueryError } from "@/drivers/types"
import type { ConnectionConfig } from "@/domain"
import type { PostgresConnectionConfig, MysqlConnectionConfig, SqliteConnectionConfig } from "@/domain"

/*
 * Containers start once for the whole suite. Test tables are given unique
 * names and dropped in a finalizer so a failed test can never leave stale
 * state behind for the next one.
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

const uid = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

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
  filename: `/tmp/dient-inspector-${uid()}.db`,
})

const value = <A, E>(exit: Exit.Exit<A, E>): A => (exit as unknown as { value: A }).value

/*
 * Run a program with the SchemaInspector + DatabaseDriver layers provided and
 * a fresh scope, so `connect`'s Scope requirement is satisfied.
 */
const runInspector = <A, E>(
  program: (inspector: SchemaInspectorService) => Effect.Effect<A, E, Scope.Scope | DatabaseDriver>
): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.provide(
        Effect.provide(
          Effect.gen(function* () {
            const inspector = yield* SchemaInspector
            return yield* program(inspector)
          }),
          SchemaInspector.layer
        ),
        DatabaseDriver.layer
      )
    )
  )

/* Connect, run `program`, and disconnect when the scope closes. */
const withConnection = <A, E>(
  config: ConnectionConfig,
  program: (conn: ActiveConnection) => Effect.Effect<A, E, Scope.Scope | DatabaseDriver>
) =>
  Effect.gen(function* () {
    const driver = yield* DatabaseDriver
    const conn = yield* driver.connect(config)
    return yield* Effect.acquireRelease(Effect.succeed(conn), c => driver.disconnect(c)).pipe(
      Effect.flatMap(c => program(c))
    )
  })

/*
 * Create tables, run `program`, and drop them again when the enclosing scope
 * closes — whether the program succeeded or failed.
 */
const withTables = <A, E>(
  conn: ActiveConnection,
  tables: ReadonlyArray<{ name: string; ddl: string }>,
  program: () => Effect.Effect<A, E, never>
): Effect.Effect<A, E | QueryError, Scope.Scope | DatabaseDriver> =>
  Effect.gen(function* () {
    const driver = yield* DatabaseDriver
    for (const table of tables) {
      yield* driver.query(conn, table.ddl)
    }
    const cleanup = Effect.acquireRelease(Effect.succeed(undefined), () =>
      Effect.all(
        [...tables].reverse().map(t => driver.query(conn, `DROP TABLE IF EXISTS ${t.name}`)),
        { discard: true }
      ).pipe(Effect.catchAll(() => Effect.void))
    )
    return yield* cleanup.pipe(Effect.flatMap(() => program()))
  })

/* ---------------------------------------------------------------------------
 * Postgres
 * ----------------------------------------------------------------------- */
describe("SchemaInspector · postgres", () => {
  const prefix = `t_${uid()}_`
  const users = { name: `${prefix}users`, email: `${prefix}email` }
  const orders = { name: `${prefix}orders` }
  const tables = [
    {
      name: users.name,
      ddl: `CREATE TABLE ${users.name} (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        nickname TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      )`,
    },
    {
      name: orders.name,
      ddl: `CREATE TABLE ${orders.name} (
        order_id INT,
        item_id INT,
        user_id BIGINT REFERENCES ${users.name}(id),
        amount NUMERIC(10, 2) DEFAULT 0,
        PRIMARY KEY (order_id, item_id)
      )`,
    },
  ]

  it("listTables returns user tables and never system tables", async () => {
    const exit = await runInspector(inspector =>
      withConnection(pgConfig(), conn => withTables(conn, tables, () => inspector.listTables(conn)))
    )
    expect(exit._tag).toBe("Success")
    const tables0 = value(exit)
    expect(tables0).toContain(users.name)
    expect(tables0).toContain(orders.name)
    expect(tables0).not.toContain("pg_catalog")
    expect(tables0).not.toContain("information_schema")
  })

  it("describeTable returns columns with types, nullability and defaults", async () => {
    const exit = await runInspector(inspector =>
      withConnection(pgConfig(), conn => withTables(conn, tables, () => inspector.describeTable(conn, users.name)))
    )
    expect(exit._tag).toBe("Success")
    const info = value(exit) as Option.Option<TableInfo>
    expect(Option.isSome(info)).toBe(true)
    const table = (info as Option.Some<TableInfo>).value
    expect(table.name).toBe(users.name)
    expect(table.primaryKey).toEqual(["id"])
    const byName = Object.fromEntries(table.columns.map(c => [c.name, c]))
    expect(byName["id"]!.type).toBe("bigint")
    expect(byName["email"]!.nullable).toBe(false)
    expect(byName["nickname"]!.nullable).toBe(true)
    expect(byName["created_at"]!.default).toBeDefined()
  })

  it("getPrimaryKey returns composite key columns in order", async () => {
    const exit = await runInspector(inspector =>
      withConnection(pgConfig(), conn => withTables(conn, tables, () => inspector.getPrimaryKey(conn, orders.name)))
    )
    expect(exit._tag).toBe("Success")
    expect(value(exit)).toEqual(["order_id", "item_id"])
  })

  it("describeTable on a missing table returns None", async () => {
    const exit = await runInspector(inspector =>
      withConnection(pgConfig(), conn => withTables(conn, tables, () => inspector.describeTable(conn, "nope_xyz")))
    )
    expect(exit._tag).toBe("Success")
    expect(Option.isNone(value(exit) as Option.Option<TableInfo>)).toBe(true)
  })

  it("getPrimaryKey on a missing table returns []", async () => {
    const exit = await runInspector(inspector =>
      withConnection(pgConfig(), conn => withTables(conn, tables, () => inspector.getPrimaryKey(conn, "nope_xyz")))
    )
    expect(exit._tag).toBe("Success")
    expect(value(exit)).toEqual([])
  })
})

/* ---------------------------------------------------------------------------
 * MySQL
 * ----------------------------------------------------------------------- */
describe("SchemaInspector · mysql", () => {
  const prefix = `t_${uid()}_`
  const users = { name: `${prefix}users`, email: `${prefix}email` }
  const orders = { name: `${prefix}orders` }
  const tables = [
    {
      name: users.name,
      ddl: `CREATE TABLE ${users.name} (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        nickname TEXT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    },
    {
      name: orders.name,
      ddl: `CREATE TABLE ${orders.name} (
        order_id INT,
        item_id INT,
        user_id BIGINT,
        amount DECIMAL(10, 2) DEFAULT 0,
        PRIMARY KEY (order_id, item_id),
        FOREIGN KEY (user_id) REFERENCES ${users.name}(id)
      )`,
    },
  ]

  it("listTables returns user tables from the current database", async () => {
    const exit = await runInspector(inspector =>
      withConnection(mysqlConfig(), conn => withTables(conn, tables, () => inspector.listTables(conn)))
    )
    expect(exit._tag).toBe("Success")
    const tables0 = value(exit)
    expect(tables0).toContain(users.name)
    expect(tables0).toContain(orders.name)
  })

  it("describeTable returns columns with types, nullability and defaults", async () => {
    const exit = await runInspector(inspector =>
      withConnection(mysqlConfig(), conn => withTables(conn, tables, () => inspector.describeTable(conn, users.name)))
    )
    expect(exit._tag).toBe("Success")
    const info = value(exit) as Option.Option<TableInfo>
    expect(Option.isSome(info)).toBe(true)
    const table = (info as Option.Some<TableInfo>).value
    expect(table.name).toBe(users.name)
    expect(table.primaryKey).toEqual(["id"])
    const byName = Object.fromEntries(table.columns.map(c => [c.name, c]))
    expect(byName["id"]!.type).toBe("bigint")
    expect(byName["email"]!.nullable).toBe(false)
    expect(byName["nickname"]!.nullable).toBe(true)
    expect(byName["created_at"]!.default).toBeDefined()
  })

  it("getPrimaryKey returns composite key columns in order", async () => {
    const exit = await runInspector(inspector =>
      withConnection(mysqlConfig(), conn => withTables(conn, tables, () => inspector.getPrimaryKey(conn, orders.name)))
    )
    expect(exit._tag).toBe("Success")
    expect(value(exit)).toEqual(["order_id", "item_id"])
  })

  it("listTables on an empty database returns []", async () => {
    const db = `dient_empty_${uid()}`
    /*
     * The container's `test` user only has privileges on its own database, so
     * the fresh empty database is managed (and listed) over the root account.
     */
    const rootConfig = (): MysqlConnectionConfig => ({
      ...mysqlConfig(),
      user: "root",
      password: mysqlContainer!.getRootPassword(),
    })
    const exit = await runInspector(inspector =>
      Effect.gen(function* () {
        const driver = yield* DatabaseDriver
        const admin = yield* driver.connect(rootConfig())
        yield* driver.query(admin, `CREATE DATABASE IF NOT EXISTS \`${db}\``)
        yield* driver.disconnect(admin)
        return yield* withConnection({ ...rootConfig(), defaultDatabase: db }, conn => inspector.listTables(conn))
      })
    )
    expect(exit._tag).toBe("Success")
    expect(value(exit)).toEqual([])
  })

  it("describeTable on a missing table returns None", async () => {
    const exit = await runInspector(inspector =>
      withConnection(mysqlConfig(), conn => withTables(conn, tables, () => inspector.describeTable(conn, "nope_xyz")))
    )
    expect(exit._tag).toBe("Success")
    expect(Option.isNone(value(exit) as Option.Option<TableInfo>)).toBe(true)
  })
})

/* ---------------------------------------------------------------------------
 * SQLite
 * ----------------------------------------------------------------------- */
describe("SchemaInspector · sqlite", () => {
  const prefix = `t_${uid()}_`
  const users = { name: `${prefix}users` }
  const orders = { name: `${prefix}orders` }
  const tables = [
    {
      name: users.name,
      ddl: `CREATE TABLE ${users.name} (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL,
        nickname TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
    },
    {
      name: orders.name,
      ddl: `CREATE TABLE ${orders.name} (
        order_id INTEGER,
        item_id INTEGER,
        user_id INTEGER REFERENCES ${users.name}(id),
        amount NUMERIC DEFAULT 0,
        PRIMARY KEY (order_id, item_id)
      )`,
    },
  ]

  it("listTables returns [] for an empty database", async () => {
    const exit = await runInspector(inspector => withConnection(sqliteConfig(), conn => inspector.listTables(conn)))
    expect(exit._tag).toBe("Success")
    expect(value(exit)).toEqual([])
  })

  it("listTables returns user tables and never sqlite internals", async () => {
    const exit = await runInspector(inspector =>
      withConnection(sqliteConfig(), conn => withTables(conn, tables, () => inspector.listTables(conn)))
    )
    expect(exit._tag).toBe("Success")
    const tables0 = value(exit)
    expect(tables0).toContain(users.name)
    expect(tables0).toContain(orders.name)
    expect(tables0.every(name => !name.startsWith("sqlite_"))).toBe(true)
  })

  it("describeTable returns columns with types, nullability and defaults", async () => {
    const exit = await runInspector(inspector =>
      withConnection(sqliteConfig(), conn => withTables(conn, tables, () => inspector.describeTable(conn, users.name)))
    )
    expect(exit._tag).toBe("Success")
    const info = value(exit) as Option.Option<TableInfo>
    expect(Option.isSome(info)).toBe(true)
    const table = (info as Option.Some<TableInfo>).value
    expect(table.name).toBe(users.name)
    expect(table.primaryKey).toEqual(["id"])
    const byName = Object.fromEntries(table.columns.map(c => [c.name, c]))
    expect(byName["id"]!.type).toBe("INTEGER")
    expect(byName["email"]!.nullable).toBe(false)
    expect(byName["nickname"]!.nullable).toBe(true)
    expect(byName["created_at"]!.default).toBeDefined()
  })

  it("getPrimaryKey returns composite key columns in order", async () => {
    const exit = await runInspector(inspector =>
      withConnection(sqliteConfig(), conn => withTables(conn, tables, () => inspector.getPrimaryKey(conn, orders.name)))
    )
    expect(exit._tag).toBe("Success")
    expect(value(exit)).toEqual(["order_id", "item_id"])
  })

  it("describeTable on a missing table returns None", async () => {
    const exit = await runInspector(inspector =>
      withConnection(sqliteConfig(), conn => withTables(conn, tables, () => inspector.describeTable(conn, "nope_xyz")))
    )
    expect(exit._tag).toBe("Success")
    expect(Option.isNone(value(exit) as Option.Option<TableInfo>)).toBe(true)
  })

  it("getPrimaryKey on a missing table returns []", async () => {
    const exit = await runInspector(inspector =>
      withConnection(sqliteConfig(), conn => withTables(conn, tables, () => inspector.getPrimaryKey(conn, "nope_xyz")))
    )
    expect(exit._tag).toBe("Success")
    expect(value(exit)).toEqual([])
  })
})
