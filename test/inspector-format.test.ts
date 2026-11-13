import { describe, expect, test } from "bun:test"
import { formatTableInfo } from "@/inspector/format"
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

describe("formatTableInfo", () => {
  test("renders DDL, columns, primary key, indexes, and foreign keys", () => {
    const text = formatTableInfo(info)
    expect(text).toContain("TABLE orders")
    expect(text).toContain("DDL")
    expect(text).toContain('CREATE TABLE "orders"')
    expect(text).toContain("COLUMNS")
    expect(text).toContain("order_id  integer  not null")
    expect(text).toContain("note      text     null · default NULL")
    expect(text).toContain("PRIMARY KEY\n  order_id")
    expect(text).toContain("orders_pkey  (order_id)  unique · primary")
    expect(text).toContain("orders_user_id_fkey  (user_id) -> users (id)")
  })

  test("shows explicit empty sections instead of hiding them", () => {
    const text = formatTableInfo({
      name: "plain",
      columns: [{ name: "id", type: "integer", nullable: true }],
      primaryKey: [],
      indexes: [],
      foreignKeys: [],
    })
    expect(text).toContain("PRIMARY KEY\n  (none)")
    expect(text).toContain("INDEXES\n  (none)")
    expect(text).toContain("FOREIGN KEYS\n  (none)")
    expect(text).not.toContain("DDL")
  })
})
