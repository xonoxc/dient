/**
 * Sidebar unit tests — the pure surface. `buildTree` flattens the
 * project → database → connection hierarchy into display rows and
 * `selectedConnection` picks the connection a row refers to, so both are
 * tested without rendering anything.
 */
import { describe, expect, test } from "bun:test"
import { Schema as S } from "effect"
import { buildTree, selectedConnection, type SidebarData } from "@/sidebar/use-sidebar"
import { ConnectionId, DatabaseId, ProjectId, type Connection, type Database, type Project } from "@/domain"

const project = (id: string, name: string): Project => ({ id: S.decodeSync(ProjectId)(id), name })
const database = (id: string, projectId: string, name: string, engine: "sqlite" | "postgres" | "mysql"): Database => ({
  id: S.decodeSync(DatabaseId)(id),
  projectId: S.decodeSync(ProjectId)(projectId),
  name,
  engine,
})
const connection = (id: string, databaseId: string, overrides: Partial<Connection> = {}): Connection => ({
  id: S.decodeSync(ConnectionId)(id),
  databaseId: S.decodeSync(DatabaseId)(databaseId),
  ...overrides,
})

/* Brand map keys so the fixture types line up with SidebarData. */
const databasesOf = (
  projectId: string,
  rows: ReadonlyArray<Database>
): ReadonlyMap<Project["id"], ReadonlyArray<Database>> =>
  new Map([[S.decodeSync(ProjectId)(projectId), rows]])
const databasesOfMany = (
  entries: ReadonlyArray<readonly [string, ReadonlyArray<Database>]>
): ReadonlyMap<Project["id"], ReadonlyArray<Database>> =>
  new Map(entries.map(([key, rows]) => [S.decodeSync(ProjectId)(key), rows]))
const connectionsOf = (
  databaseId: string,
  rows: ReadonlyArray<Connection>
): ReadonlyMap<Database["id"], ReadonlyArray<Connection>> =>
  new Map([[S.decodeSync(DatabaseId)(databaseId), rows]])

describe("buildTree", () => {
  test("returns an empty list for empty data", () => {
    const data: SidebarData = { projects: [], databases: new Map(), connections: new Map() }
    expect(buildTree(data, new Set())).toEqual([])
  })

  test("renders a project as a collapsed expandable row", () => {
    const p = project("p1", "demo")
    const data: SidebarData = { projects: [p], databases: new Map(), connections: new Map() }
    const nodes = buildTree(data, new Set())
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ kind: "project", refId: p.id, label: "demo", depth: 0, expanded: false, expandable: true })
  })

  test("an expanded project surfaces its databases at depth 1", () => {
    const p = project("p1", "demo")
    const db = database("d1", "p1", "main", "sqlite")
    const data: SidebarData = { projects: [p], databases: databasesOf("p1", [db]), connections: new Map() }
    const nodes = buildTree(data, new Set(["p1"]))
    expect(nodes).toHaveLength(2)
    expect(nodes[1]).toMatchObject({ kind: "database", refId: db.id, label: "main", depth: 1, expanded: false })
  })

  test("an expanded database surfaces its connections at depth 2", () => {
    const p = project("p1", "demo")
    const db = database("d1", "p1", "main", "sqlite")
    const conn = connection("c1", "d1", { filename: "/tmp/data.db" })
    const data: SidebarData = {
      projects: [p],
      databases: databasesOf("p1", [db]),
      connections: connectionsOf("d1", [conn]),
    }
    const nodes = buildTree(data, new Set(["p1", "d1"]))
    expect(nodes).toHaveLength(3)
    expect(nodes[2]).toMatchObject({ kind: "connection", refId: conn.id, depth: 2, expandable: false })
  })

  test("collapsing a node hides its children", () => {
    const p = project("p1", "demo")
    const db = database("d1", "p1", "main", "sqlite")
    const data: SidebarData = { projects: [p], databases: databasesOf("p1", [db]), connections: new Map() }
    expect(buildTree(data, new Set(["p1", "d1"]))).toHaveLength(2)
    expect(buildTree(data, new Set([]))).toHaveLength(1)
  })

  test("projects are emitted in order, each with its children", () => {
    const data: SidebarData = {
      projects: [project("p1", "alpha"), project("p2", "beta")],
      databases: databasesOfMany([
        ["p1", [database("d1", "p1", "a-db", "mysql")]],
        ["p2", [database("d2", "p2", "b-db", "postgres")]],
      ]),
      connections: connectionsOf("d1", [connection("c1", "d1", { filename: "x.db" })]),
    }
    const nodes = buildTree(data, new Set(["p1", "d1", "p2", "d2"]))
    expect(nodes.map(n => n.label)).toEqual(["alpha", "a-db", "x.db", "beta", "b-db"])
  })

  test("connection labels are derived from the filename basename", () => {
    const data: SidebarData = {
      projects: [project("p1", "demo")],
      databases: databasesOf("p1", [database("d1", "p1", "main", "sqlite")]),
      connections: connectionsOf("d1", [connection("c1", "d1", { filename: "/deep/path/data.db" })]),
    }
    const nodes = buildTree(data, new Set(["p1", "d1"]))
    expect(nodes[2]!.label).toBe("data.db")
  })

  test("expansion is tracked by refId, not by display id", () => {
    const p = project("p1", "demo")
    const data: SidebarData = { projects: [p], databases: new Map(), connections: new Map() }
    const nodes = buildTree(data, new Set(["not-a-real-id"]))
    expect(nodes[0]!.expanded).toBe(false)
    expect(buildTree(data, new Set([p.id]))[0]!.expanded).toBe(true)
  })
})

describe("selectedConnection", () => {
  test("returns null for a non-connection row", () => {
    const nodes = buildTree({ projects: [project("p1", "demo")], databases: new Map(), connections: new Map() }, new Set())
    expect(selectedConnection(nodes, 0)).toBeNull()
  })

  test("returns the connection node for a connection row", () => {
    const data: SidebarData = {
      projects: [project("p1", "demo")],
      databases: databasesOf("p1", [database("d1", "p1", "main", "sqlite")]),
      connections: connectionsOf("d1", [connection("c1", "d1", { filename: "data.db" })]),
    }
    const nodes = buildTree(data, new Set(["p1", "d1"]))
    const selected = selectedConnection(nodes, 2)
    expect(selected).not.toBeNull()
    expect(selected!.kind).toBe("connection")
    expect(selected!.connection).toMatchObject({ id: S.decodeSync(ConnectionId)("c1") })
  })

  test("returns null out of range", () => {
    const nodes = buildTree(
      { projects: [project("p1", "demo")], databases: new Map(), connections: new Map() },
      new Set()
    )
    expect(selectedConnection(nodes, 9)).toBeNull()
  })
})