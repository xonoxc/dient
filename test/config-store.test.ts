import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigStore } from "@/config"
import type { ProjectId, DatabaseId } from "@/domain"

const freshDb = () => join(mkdtempSync(join(tmpdir(), "dient-")), "config.db")

const run = async <A>(file: string, fn: Effect.Effect<A, any, ConfigStore>): Promise<A> =>
  Effect.runPromise(Effect.provide(fn, ConfigStore.layer(file)))

describe("Projects CRUD", () => {
  test("createProject returns Project with generated ID", async () => {
    const project = await run(
      freshDb(),
      Effect.gen(function* () {
        const store = yield* ConfigStore
        return yield* store.createProject({ name: "my-app" })
      })
    )
    expect(project.name).toBe("my-app")
    expect(typeof project.id).toBe("string")
    expect(project.id.length).toBeGreaterThan(0)
  })

  test("listProjects returns all stored projects", async () => {
    await run(
      freshDb(),
      Effect.gen(function* () {
        const store = yield* ConfigStore
        yield* store.createProject({ name: "alpha" })
        yield* store.createProject({ name: "beta" })
        const list = yield* store.listProjects()
        expect(list.length).toBe(2)
        expect(list.map(p => p.name).sort()).toEqual(["alpha", "beta"])
      })
    )
  })

  test("listProjects returns empty array when no projects", async () => {
    await run(
      freshDb(),
      Effect.gen(function* () {
        const store = yield* ConfigStore
        const list = yield* store.listProjects()
        expect(list.length).toBe(0)
      })
    )
  })

  test("updateProject persists changes", async () => {
    await run(
      freshDb(),
      Effect.gen(function* () {
        const store = yield* ConfigStore
        const { id } = yield* store.createProject({ name: "old-name" })
        const updated = yield* store.updateProject(id, "new-name")
        expect(updated.name).toBe("new-name")
        expect(updated.id).toBe(id)
        const list = yield* store.listProjects()
        expect(list.find(p => p.id === id)?.name).toBe("new-name")
      })
    )
  })

  test("deleteProject cascades to databases and connections", async () => {
    await run(
      freshDb(),
      Effect.gen(function* () {
        const store = yield* ConfigStore
        const project = yield* store.createProject({ name: "p" })
        const db = yield* store.createDatabase({ projectId: project.id, name: "db1", engine: "postgres" })
        yield* store.createConnection({ databaseId: db.id, host: "localhost" })
        yield* store.deleteProject(project.id)
        expect((yield* store.listProjects()).length).toBe(0)
        expect((yield* store.listDatabases(project.id)).length).toBe(0)
        expect((yield* store.listConnections(db.id)).length).toBe(0)
      })
    )
  })
})

describe("Databases CRUD", () => {
  test("createDatabase returns Database with generated ID", async () => {
    await run(
      freshDb(),
      Effect.gen(function* () {
        const store = yield* ConfigStore
        const project = yield* store.createProject({ name: "p" })
        const db = yield* store.createDatabase({ projectId: project.id, name: "prod", engine: "postgres" })
        expect(db.name).toBe("prod")
        expect(db.engine).toBe("postgres")
        expect(db.projectId).toBe(project.id)
      })
    )
  })

  test("listDatabases scoped to project", async () => {
    await run(
      freshDb(),
      Effect.gen(function* () {
        const store = yield* ConfigStore
        const p1 = yield* store.createProject({ name: "p1" })
        const p2 = yield* store.createProject({ name: "p2" })
        yield* store.createDatabase({ projectId: p1.id, name: "a", engine: "postgres" })
        yield* store.createDatabase({ projectId: p1.id, name: "b", engine: "mysql" })
        yield* store.createDatabase({ projectId: p2.id, name: "c", engine: "sqlite" })
        expect((yield* store.listDatabases(p1.id)).length).toBe(2)
        const list2 = yield* store.listDatabases(p2.id)
        expect(list2.length).toBe(1)
        expect(list2[0]?.name).toBe("c")
      })
    )
  })

  test("deleteDatabase cascades to connections", async () => {
    await run(
      freshDb(),
      Effect.gen(function* () {
        const store = yield* ConfigStore
        const project = yield* store.createProject({ name: "p" })
        const db = yield* store.createDatabase({ projectId: project.id, name: "db", engine: "sqlite" })
        yield* store.createConnection({ databaseId: db.id, filename: "/tmp/d.db" })
        yield* store.deleteDatabase(db.id)
        expect((yield* store.listConnections(db.id)).length).toBe(0)
      })
    )
  })
})

describe("Connections CRUD", () => {
  test("createConnection returns Connection with generated ID", async () => {
    await run(
      freshDb(),
      Effect.gen(function* () {
        const store = yield* ConfigStore
        const project = yield* store.createProject({ name: "p" })
        const db = yield* store.createDatabase({ projectId: project.id, name: "db", engine: "postgres" })
        const conn = yield* store.createConnection({ databaseId: db.id, host: "localhost", port: 5432, user: "admin" })
        expect(conn.databaseId).toBe(db.id)
        expect(conn.host).toBe("localhost")
        expect(conn.port).toBe(5432)
        expect(conn.user).toBe("admin")
      })
    )
  })

  test("createConnection with optional fields omitted", async () => {
    await run(
      freshDb(),
      Effect.gen(function* () {
        const store = yield* ConfigStore
        const project = yield* store.createProject({ name: "p" })
        const db = yield* store.createDatabase({ projectId: project.id, name: "db", engine: "sqlite" })
        const conn = yield* store.createConnection({ databaseId: db.id, filename: "/tmp/d.db" })
        expect(conn.filename).toBe("/tmp/d.db")
        expect(conn.host).toBeUndefined()
        expect(conn.port).toBeUndefined()
      })
    )
  })

  test("listConnections scoped to database", async () => {
    await run(
      freshDb(),
      Effect.gen(function* () {
        const store = yield* ConfigStore
        const project = yield* store.createProject({ name: "p" })
        const db1 = yield* store.createDatabase({ projectId: project.id, name: "d1", engine: "postgres" })
        const db2 = yield* store.createDatabase({ projectId: project.id, name: "d2", engine: "mysql" })
        yield* store.createConnection({ databaseId: db1.id, host: "h1" })
        yield* store.createConnection({ databaseId: db1.id, host: "h2" })
        yield* store.createConnection({ databaseId: db2.id, host: "h3" })
        expect((yield* store.listConnections(db1.id)).length).toBe(2)
        expect((yield* store.listConnections(db2.id)).length).toBe(1)
      })
    )
  })

  test("updateConnection persists changes", async () => {
    await run(
      freshDb(),
      Effect.gen(function* () {
        const store = yield* ConfigStore
        const project = yield* store.createProject({ name: "p" })
        const db = yield* store.createDatabase({ projectId: project.id, name: "db", engine: "postgres" })
        const conn = yield* store.createConnection({ databaseId: db.id, host: "old" })
        const updated = yield* store.updateConnection(conn.id, { host: "new", port: 9999 })
        expect(updated.host).toBe("new")
        expect(updated.port).toBe(9999)
      })
    )
  })

  test("deleteConnection", async () => {
    await run(
      freshDb(),
      Effect.gen(function* () {
        const store = yield* ConfigStore
        const project = yield* store.createProject({ name: "p" })
        const db = yield* store.createDatabase({ projectId: project.id, name: "db", engine: "postgres" })
        const conn = yield* store.createConnection({ databaseId: db.id, host: "x" })
        yield* store.deleteConnection(conn.id)
        expect((yield* store.listConnections(db.id)).length).toBe(0)
      })
    )
  })
})

describe("Filesystem", () => {
  test("handles missing parent directory (creates it)", async () => {
    const dir = freshDb()
    const deep = join(dir, "..", "nested", "deeper", "config.db")
    await run(
      deep,
      Effect.gen(function* () {
        const store = yield* ConfigStore
        const project = yield* store.createProject({ name: "deep" })
        expect(project.name).toBe("deep")
        expect((yield* store.listProjects()).length).toBe(1)
      })
    )
  })
})
