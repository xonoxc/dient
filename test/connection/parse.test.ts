/**
 * Connection-string parser tests. A pasted string becomes a connection: no
 * scheme means SQLite path (name from the tail), a server URL carries
 * host/port/credentials with the database name taken from its path, and a
 * server URL with no path reports no name so the caller can prompt for it.
 */
import { describe, expect, test } from "bun:test"
import { parseConnectionString } from "@/connection/parse"

type ServerString = Extract<ReturnType<typeof parseConnectionString>, { engine: "postgres" | "mysql" }>

describe("parseConnectionString", () => {
  test("an empty string is not parseable", () => {
    expect(parseConnectionString("")).toBeNull()
    expect(parseConnectionString("   ")).toBeNull()
  })

  test("a bare path is a sqlite connection named from the tail", () => {
    const parsed = parseConnectionString("/data/some_db.db")
    expect(parsed).toEqual({ engine: "sqlite", filename: "/data/some_db.db", name: "some_db" })
  })

  test("a bare relative filename names itself in a user-friendly way", () => {
    const parsed = parseConnectionString("./sample.db")
    expect(parsed).toEqual({ engine: "sqlite", filename: "./sample.db", name: "sample" })
  })

  test("a sqlite:// URI works and drops the scheme", () => {
    const parsed = parseConnectionString("sqlite:///tmp/orders.db")
    expect(parsed).toEqual({ engine: "sqlite", filename: "/tmp/orders.db", name: "orders" })
  })

  test("a file:// URI works and drops the scheme", () => {
    const parsed = parseConnectionString("file://data.db")
    expect(parsed).toEqual({ engine: "sqlite", filename: "data.db", name: "data" })
  })

  test("a postgres URL parses host, port, credentials, and database tail", () => {
    const parsed = parseConnectionString(
      "postgres://user:pw@example.com:5433/reporting?sslmode=require"
    ) as ServerString
    expect(parsed?.engine).toBe("postgres")
    expect(parsed?.host).toBe("example.com")
    expect(parsed?.port).toBe(5433)
    expect(parsed?.user).toBe("user")
    expect(parsed?.password).toBe("pw")
    expect(parsed?.name).toBe("reporting")
    expect(parsed?.defaultDatabase).toBe("reporting")
  })

  test("postgresql:// is accepted as postgres", () => {
    const parsed = parseConnectionString("postgresql://h/app") as ServerString
    expect(parsed?.engine).toBe("postgres")
    expect(parsed?.host).toBe("h")
    expect(parsed?.name).toBe("app")
  })

  test("a mysql URL parses the same way", () => {
    const parsed = parseConnectionString("mysql://root@db:3306/shop") as ServerString
    expect(parsed?.engine).toBe("mysql")
    expect(parsed?.host).toBe("db")
    expect(parsed?.port).toBe(3306)
    expect(parsed?.user).toBe("root")
    expect(parsed?.name).toBe("shop")
  })

  test("a server URL with no path has no name (caller asks for it)", () => {
    const parsed = parseConnectionString("postgres://user:pw@example.com:5432/") as ServerString
    expect(parsed?.engine).toBe("postgres")
    expect(parsed?.name).toBeUndefined()
  })

  test("unknownown schemes are rejected", () => {
    expect(parseConnectionString("mongodb://host/db")).toBeNull()
  })
})

type RedisString = Extract<ReturnType<typeof parseConnectionString>, { engine: "redis" }>

describe("parseConnectionString redis", () => {
  test("a redis URL carries host, port, and a logical database index", () => {
    const parsed = parseConnectionString("redis://localhost:6379/2") as RedisString
    expect(parsed?.engine).toBe("redis")
    expect(parsed?.host).toBe("localhost")
    expect(parsed?.port).toBe(6379)
    expect(parsed?.defaultDatabase).toBe("2")
    expect(parsed?.name).toBe("localhost:6379/2")
    expect(parsed?.tls).toBeUndefined()
  })

  test("rediss enables TLS and decodes credentials", () => {
    const parsed = parseConnectionString("rediss://user:p%40ss@cache.example.com:6380/0") as RedisString
    expect(parsed?.engine).toBe("redis")
    expect(parsed?.tls).toBe(true)
    expect(parsed?.user).toBe("user")
    expect(parsed?.password).toBe("p@ss")
    expect(parsed?.defaultDatabase).toBe("0")
    expect(parsed?.name).toBe("cache.example.com:6380")
  })

  test("valkey and valkeys are accepted as Redis", () => {
    expect(parseConnectionString("valkey://cache:6379")?.engine).toBe("redis")
    const secure = parseConnectionString("valkeys://cache:6379/3") as RedisString
    expect(secure?.tls).toBe(true)
    expect(secure?.defaultDatabase).toBe("3")
  })

  test("a password-only URL is accepted", () => {
    const parsed = parseConnectionString("redis://:secret@host") as RedisString
    expect(parsed?.password).toBe("secret")
    expect(parsed?.user).toBeUndefined()
  })

  test("a malformed percent escape does not crash the parser", () => {
    const parsed = parseConnectionString("redis://user:p%zz@host/0") as RedisString
    expect(parsed?.engine).toBe("redis")
    expect(parsed?.password).toBe("p%zz")
  })

  test("a non-numeric Redis path is rejected", () => {
    expect(parseConnectionString("redis://host/cache")).toBeNull()
  })

  test("a Redis URL with no path still has a display name", () => {
    const parsed = parseConnectionString("redis://host") as RedisString
    expect(parsed?.name).toBe("host:6379")
    expect(parsed?.defaultDatabase).toBeUndefined()
  })
})
