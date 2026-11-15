import { describe, expect, test } from "bun:test"
import { schemaRows, schemaViewerRowCount, type SchemaRow } from "@/explorer/schema-viewer"
import type { TableInfo } from "@/inspector/types"

const info: TableInfo = {
  name: "orders",
  columns: [
    { name: "order_id", type: "integer", nullable: false },
    { name: "user_id", type: "bigint", nullable: false },
    { name: "note", type: "text", nullable: true, default: "NULL" },
  ],
  primaryKey: ["order_id"],
  indexes: [
    { name: "orders_pkey", columns: ["order_id"], unique: true, primary: true },
    { name: "orders_user_id_idx", columns: ["user_id"], unique: false, primary: false },
  ],
  foreignKeys: [
    {
      name: "orders_user_id_fkey",
      columns: ["user_id"],
      referencedTable: "users",
      referencedColumns: ["id"],
    },
  ],
  ddl: 'CREATE TABLE "orders" (\n  "order_id" integer NOT NULL\n);',
}

const textOf = (rows: ReadonlyArray<SchemaRow>): string =>
  rows
    .map(row => {
      if (row.kind === "blank") return ""
      if (row.kind === "heading") return row.text
      if (row.kind === "text") return row.text
      return row.cells.map(schemaCell => schemaCell.text).join("|")
    })
    .join("\n")

describe("schema viewer rows", () => {
  test("renders a column grid, key column, indexes, foreign keys, and wrapped DDL", () => {
    const rows = schemaRows(info, 72)
    const text = textOf(rows)

    /* Column grid: header row, then one aligned row per column with the pk
       marker in its own KEY cell. */
    expect(text).toContain("COLUMNS")
    expect(text).toContain("NAME|")
    expect(text).toMatch(/order_id.*integer.*not null.*pk/)
    expect(text).toMatch(/note.*text.*null.*default NULL/)

    expect(text).toContain("PRIMARY KEY")
    expect(text).toContain("order_id")

    expect(text).toContain("INDEXES")
    expect(text).toContain("orders_pkey")
    expect(text).toContain("(order_id)")
    expect(text).toContain("unique · primary")

    expect(text).toContain("FOREIGN KEYS")
    expect(text).toContain("orders_user_id_fkey")
    expect(text).toContain("(user_id) -> users (id)")

    expect(text).toContain("DDL")
    expect(text).toContain('CREATE TABLE "orders"')
    expect(text).toContain('"order_id" integer NOT NULL')
  })

  test("columns come before the DDL so the grid is the first thing you see", () => {
    const rows = schemaRows(info, 72)
    const kinds = rows.map(row => row.kind)
    const columnsAt = kinds.indexOf("heading") /* first heading is COLUMNS */
    const text = textOf(rows)
    expect(text.indexOf("COLUMNS")).toBeLessThan(text.indexOf("DDL"))
    expect(rows[columnsAt]).toEqual({ kind: "heading", text: "COLUMNS" })
  })

  test("empty sections say (none) instead of vanishing", () => {
    const text = textOf(
      schemaRows(
        {
          name: "plain",
          columns: [{ name: "id", type: "integer", nullable: true }],
          primaryKey: [],
          indexes: [],
          foreignKeys: [],
        },
        72
      )
    )
    expect(text).toContain("PRIMARY KEY")
    expect(text).toContain("(none)")
    expect(text).toContain("FOREIGN KEYS")
    expect(text).not.toContain("DDL")
  })

  test("row count matches the built rows so scrolling reaches the end", () => {
    const rows = schemaRows(info, 72)
    expect(schemaViewerRowCount(info, 72)).toBe(rows.length)
  })
})
