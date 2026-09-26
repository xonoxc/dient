/**
 * Sidebar unit tests — the pure surface. `buildTree` flattens the
 * project → database → connection hierarchy into display rows and
 * `selectedConnection` picks the connection a row refers to, so both are
 * tested without rendering anything.
 */
import { describe, expect, test } from "bun:test"
import { Schema as S } from "effect"
import { buildTree, selectedConnection, type SidebarData } from "@/sidebar/use-sidebar"
import { fitLabel, SIDEBAR_WIDTH } from "@/sidebar/fit-label"
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
): ReadonlyMap<Project["id"], ReadonlyArray<Database>> => new Map([[S.decodeSync(ProjectId)(projectId), rows]])
const databasesOfMany = (
  entries: ReadonlyArray<readonly [string, ReadonlyArray<Database>]>
): ReadonlyMap<Project["id"], ReadonlyArray<Database>> =>
  new Map(entries.map(([key, rows]) => [S.decodeSync(ProjectId)(key), rows]))
const connectionsOf = (
  databaseId: string,
  rows: ReadonlyArray<Connection>
): ReadonlyMap<Database["id"], ReadonlyArray<Connection>> => new Map([[S.decodeSync(DatabaseId)(databaseId), rows]])

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
    expect(nodes[0]).toMatchObject({
      kind: "project",
      refId: p.id,
      label: "demo",
      depth: 0,
      expanded: false,
      expandable: true,
    })
  })

  test("an expanded project surfaces its databases at depth 1", () => {
    const p = project("p1", "demo")
    const db = database("d1", "p1", "main", "sqlite")
    const data: SidebarData = { projects: [p], databases: databasesOf("p1", [db]), connections: new Map() }
    const nodes = buildTree(data, new Set(["p1"]))
    expect(nodes).toHaveLength(2)
    expect(nodes[1]).toMatchObject({ kind: "database", refId: db.id, label: "main", depth: 1, expanded: false, expandable: false })
  })

  test("a database with a connection folds the connection into the database row", () => {
    const p = project("p1", "demo")
    const db = database("d1", "p1", "main", "sqlite")
    const conn = connection("c1", "d1", { filename: "/tmp/data.db" })
    const data: SidebarData = {
      projects: [p],
      databases: databasesOf("p1", [db]),
      connections: connectionsOf("d1", [conn]),
    }
    const nodes = buildTree(data, new Set(["p1"]))
    expect(nodes).toHaveLength(2)
    expect(nodes[1]).toMatchObject({
      kind: "connection",
      refId: conn.id,
      label: "main",
      depth: 1,
      expandable: true,
    })
  })

  test("an expanded connection surfaces its tables as depth-2 leaves", () => {
    const p = project("p1", "demo")
    const db = database("d1", "p1", "main", "sqlite")
    const conn = connection("c1", "d1", { filename: "/tmp/data.db" })
    const data: SidebarData = {
      projects: [p],
      databases: databasesOf("p1", [db]),
      connections: connectionsOf("d1", [conn]),
    }
    const nodes = buildTree(data, new Set(["p1", "c1"]), {
      [conn.id as ConnectionId]: ["users", "orders"],
    })
    expect(nodes.map(n => ({ kind: n.kind, label: n.label, depth: n.depth }))).toEqual([
      { kind: "project", label: "demo", depth: 0 },
      { kind: "connection", label: "main", depth: 1 },
      { kind: "table", label: "users", depth: 2 },
      { kind: "table", label: "orders", depth: 2 },
    ])
    expect(nodes[3]).toMatchObject({ kind: "table", table: "orders", expandable: false })
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
    expect(nodes.map(n => n.label)).toEqual(["alpha", "a-db", "beta", "b-db"])
  })

  test("the database row carries its connection's params", () => {
    const data: SidebarData = {
      projects: [project("p1", "demo")],
      databases: databasesOf("p1", [database("d1", "p1", "main", "sqlite")]),
      connections: connectionsOf("d1", [connection("c1", "d1", { filename: "/deep/path/data.db" })]),
    }
    const nodes = buildTree(data, new Set(["p1"]))
    expect(nodes[1]!.label).toBe("main")
    expect(nodes[1]!.connection?.filename).toBe("/deep/path/data.db")
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
    const nodes = buildTree(
      { projects: [project("p1", "demo")], databases: new Map(), connections: new Map() },
      new Set()
    )
    expect(selectedConnection(nodes, 0)).toBeNull()
  })

  test("returns the connection node for a connection row", () => {
    const data: SidebarData = {
      projects: [project("p1", "demo")],
      databases: databasesOf("p1", [database("d1", "p1", "main", "sqlite")]),
      connections: connectionsOf("d1", [connection("c1", "d1", { filename: "data.db" })]),
    }
    const nodes = buildTree(data, new Set(["p1"]))
    const selected = selectedConnection(nodes, 1)
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

describe("fitLabel", () => {
  /* A row whose label overran the panel used to render as *nothing* — not a
     clipped prefix, an empty row. Real schemas are full of long names, so the
     budget and the ellipsis are part of the contract. */
  test("leaves a label that fits alone", () => {
    expect(fitLabel("Games", 6)).toBe("Games")
  })

  test("clips a label that overruns the panel instead of dropping the row", () => {
    const clipped = fitLabel("ProviderRestrictedCountry", 6)
    expect(clipped.endsWith("…")).toBe(true)
    /* The real contract, measured rather than assumed: a row whose content
       reaches the panel edge is measured at zero columns and draws nothing at
       all. Content must stay 2 columns short of the 29 usable columns. */
    expect(6 + clipped.length).toBeLessThanOrEqual(SIDEBAR_WIDTH - 5)
  })

  /* The budget is the panel minus the 1-cell divider, 2 cells of row padding
     and the 2-cell safety margin, so these widths leave 2, 1, 0 and negative
     cells of label room respectively. */
  test("keeps one character plus the ellipsis when only two cells remain", () => {
    expect(fitLabel("Anything", 0, 7)).toBe("A…")
  })

  test("degenerates to an ellipsis rather than a negative slice", () => {
    expect(fitLabel("Anything", 0, 6)).toBe("…")
    expect(fitLabel("Anything", 0, 5)).toBe("")
    expect(fitLabel("Anything", 0, 1)).toBe("")
  })

  /* `ProviderRestrictedCountry` is 25 characters and the depth-2 budget is 23.
     It used to be returned whole, which filled the row and blanked it. */
  test("the deepest table in a real schema is clipped short of the panel edge", () => {
    const clipped = fitLabel("ProviderRestrictedCountry", 4)
    expect(clipped).toBe("ProviderRestrictedCoun…")
    /* 2 indent + "▸ " + label, and still 2 columns clear of the edge. */
    expect(4 + clipped.length).toBeLessThanOrEqual(SIDEBAR_WIDTH - 5)
  })

  /* Every length must stay drawn: a row either shows the name or shows a
     clipped prefix with an ellipsis, never a silently blank line. */
  test("no label length can produce a row wider than the safe content width", () => {
    for (let length = 1; length <= 60; length++) {
      const clipped = fitLabel("n".repeat(length), 4)
      expect(4 + clipped.length).toBeLessThanOrEqual(SIDEBAR_WIDTH - 5)
      if (length <= 23) expect(clipped).toBe("n".repeat(length))
      else expect(clipped.endsWith("…")).toBe(true)
    }
  })
})
