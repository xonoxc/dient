import { describe, expect, test } from "bun:test"
import { Schema as S } from "effect"
import {
  ConnectionConfig,
  ConnectionSchema,
  DatabaseSchema,
  PostgresConnectionConfig,
  ProjectSchema,
  SqliteConnectionConfig,
} from "@/domain"

const as = <T>(value: unknown): T => value as T

const encoded = <A, I>(schema: S.Schema<A, I>, value: A): I => S.encodeSync(schema)(value)

describe("ProjectSchema", () => {
  test("decodes and encodes a valid project", () => {
    const input = {
      id: "p1",
      name: "my-project",
    }
    const decoded = S.decodeSync(ProjectSchema)(input)
    expect(encoded(ProjectSchema, decoded)).toEqual(input)
  })

  test("rejects missing required fields", () => {
    expect(() => S.decodeSync(ProjectSchema)(as({ name: "my-project" }))).toThrow()
    expect(() => S.decodeSync(ProjectSchema)(as({ id: "p1" }))).toThrow()
  })

  test("rejects a non-string id", () => {
    expect(() => S.decodeSync(ProjectSchema)(as({ id: 1, name: "my-project" }))).toThrow()
  })
})

describe("DatabaseSchema", () => {
  test("decodes and encodes a valid database", () => {
    const input = {
      id: "d1",
      projectId: "p1",
      name: "production",
      engine: "postgres" as const,
    }
    const decoded = S.decodeSync(DatabaseSchema)(input)
    expect(encoded(DatabaseSchema, decoded)).toEqual(input)
  })

  test("accepts every valid engine", () => {
    for (const engine of ["postgres", "mysql", "sqlite"] as const) {
      const input = {
        id: "d1",
        projectId: "p1",
        name: "db",
        engine,
      }
      const decoded = S.decodeSync(DatabaseSchema)(input)
      expect(encoded(DatabaseSchema, decoded)).toEqual(input)
    }
  })

  test("rejects an invalid engine at runtime", () => {
    expect(() =>
      S.decodeSync(DatabaseSchema)(as({ id: "d1", projectId: "p1", name: "db", engine: "oracle" }))
    ).toThrow()
  })

  test("rejects missing required fields", () => {
    expect(() =>
      S.decodeSync(DatabaseSchema)(
        as({
          projectId: "p1",
          name: "db",
          engine: "postgres",
        })
      )
    ).toThrow()
    expect(() =>
      S.decodeSync(DatabaseSchema)(
        as({
          id: "d1",
          name: "db",
          engine: "postgres",
        })
      )
    ).toThrow()
    expect(() => S.decodeSync(DatabaseSchema)(as({ id: "d1", projectId: "p1", engine: "postgres" }))).toThrow()
  })
})

describe("ConnectionSchema", () => {
  test("decodes and encodes a minimal connection", () => {
    const input = { id: "c1", databaseId: "d1" }
    const decoded = S.decodeSync(ConnectionSchema)(input)
    expect(encoded(ConnectionSchema, decoded)).toEqual(input)
  })

  test("decodes and encodes a connection with all optional fields", () => {
    const input = {
      id: "c1",
      databaseId: "d1",
      host: "localhost",
      port: 5432,
      user: "admin",
      password: "secret",
      filename: "/tmp/x.db",
      defaultDatabase: "app",
    }
    const decoded = S.decodeSync(ConnectionSchema)(input)
    expect(encoded(ConnectionSchema, decoded)).toEqual(input)
  })

  test("optional fields default to undefined", () => {
    const decoded = S.decodeSync(ConnectionSchema)(as({ id: "c1", databaseId: "d1" }))
    expect(decoded.host).toBeUndefined()
    expect(decoded.port).toBeUndefined()
  })

  test("rejects missing required fields", () => {
    expect(() => S.decodeSync(ConnectionSchema)(as({ databaseId: "d1" }))).toThrow()
    expect(() => S.decodeSync(ConnectionSchema)(as({ id: "c1" }))).toThrow()
  })

  test("rejects a non-string id", () => {
    expect(() => S.decodeSync(ConnectionSchema)(as({ id: 5, databaseId: "d1" }))).toThrow()
  })
})

describe("ConnectionConfig (discriminated union by engine)", () => {
  test("decodes and encodes a valid postgres config", () => {
    const input = {
      engine: "postgres" as const,
      host: "localhost",
      port: 5432,
      defaultDatabase: "app",
    }
    const decoded = S.decodeSync(ConnectionConfig)(input)
    expect(encoded(ConnectionConfig, decoded)).toEqual(input)
  })

  test("decodes and encodes a valid mysql config", () => {
    const input = {
      engine: "mysql" as const,
      host: "127.0.0.1",
      user: "admin",
      password: "p",
    }
    const decoded = S.decodeSync(ConnectionConfig)(input)
    expect(encoded(ConnectionConfig, decoded)).toEqual(input)
  })

  test("decodes and encodes a valid sqlite config", () => {
    const input = {
      engine: "sqlite" as const,
      filename: "/tmp/dient.db",
    }
    const decoded = S.decodeSync(ConnectionConfig)(input)
    expect(encoded(ConnectionConfig, decoded)).toEqual(input)
  })

  test("rejects an invalid engine at runtime", () => {
    expect(() =>
      S.decodeSync(ConnectionConfig)(
        as({
          engine: "oracle",
          host: "localhost",
        })
      )
    ).toThrow()
  })

  test("rejects sqlite config missing filename", () => {
    expect(() => S.decodeSync(ConnectionConfig)(as({ engine: "sqlite" }))).toThrow()
  })

  test("rejects postgres config with wrong field type", () => {
    expect(() =>
      S.decodeSync(ConnectionConfig)(
        as({
          engine: "postgres",
          port: "not-a-number",
        })
      )
    ).toThrow()
  })

  test("round-trips a postgres config through the union schema", () => {
    const decoded = S.decodeSync(PostgresConnectionConfig)({
      engine: "postgres",
      host: "localhost",
    })
    expect(encoded(ConnectionConfig, decoded)).toEqual({ engine: "postgres", host: "localhost" })
  })

  test("round-trips a sqlite config through the union schema", () => {
    const decoded = S.decodeSync(SqliteConnectionConfig)({
      engine: "sqlite",
      filename: "/tmp/dient.db",
    })
    expect(encoded(ConnectionConfig, decoded)).toEqual({ engine: "sqlite", filename: "/tmp/dient.db" })
  })
})
