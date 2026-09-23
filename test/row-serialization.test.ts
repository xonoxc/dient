/**
 * Row ↔ `$EDITOR` file serialization unit tests. The `$EDITOR` row editor hands
 * the cursor row to the user's editor as schema-ordered `column: value` lines
 * (with a comment header) and parses the edited file back into typed UPDATE
 * parameters — primary key columns are never written, unchanged columns are
 * dropped, and values are validated against the column type before anything is
 * passed to the write path. Malformed input fails with a line-numbered error
 * and never touches the database.
 */
import { describe, expect, test } from "bun:test"
import type { TableColumn } from "@/inspector/types"
import { parseFieldValue, parseRowKeyValue, serializeRowToKeyValue } from "@/editor/row-serialization"

const USERS: ReadonlyArray<TableColumn> = [
  { name: "id", type: "INTEGER", nullable: false },
  { name: "name", type: "TEXT", nullable: false },
  { name: "email", type: "TEXT", nullable: true },
]

const ALICE = { id: 1, name: "alice", email: "alice@example.com" }

const HDR_1 = "# Edit values using: column: value"
const HDR_2 = "# Use NULL explicitly for SQL NULL."
const HDR_3 = "# Missing columns are left unchanged."

describe("serializeRowToKeyValue", () => {
  test("writes the comment header then one column: value line per schema column", () => {
    const text = serializeRowToKeyValue(USERS, ALICE)
    expect(text.split("\n")).toEqual([
      HDR_1,
      HDR_2,
      HDR_3,
      "id: 1",
      "name: alice",
      "email: alice@example.com",
      "",
    ])
  })

  test("writes SQL NULL explicitly and empty strings as quoted empties", () => {
    const nullRow = serializeRowToKeyValue(USERS, { id: 1, name: "bob", email: null })
    expect(nullRow).toContain("email: NULL")
    expect(nullRow).not.toContain("email: ∅")

    const emptyRow = serializeRowToKeyValue(USERS, { id: 1, name: "", email: "" })
    expect(emptyRow).toContain("name: \"\"")
    expect(emptyRow).toContain("email: \"\"")
  })

  test("derives the lines from the schema, not hardcoded names", () => {
    const ORDERS: ReadonlyArray<TableColumn> = [
      { name: "id", type: "INTEGER", nullable: false },
      { name: "placed_at", type: "TEXT", nullable: false },
    ]
    expect(serializeRowToKeyValue(ORDERS, { id: 3, placed_at: "2000-04-10" })).toContain(
      "placed_at: 2000-04-10"
    )
  })
})

describe("parseRowKeyValue", () => {
  test("an untouched file reports no changes", () => {
    expect(parseRowKeyValue(serializeRowToKeyValue(USERS, ALICE), USERS, ["id"], ALICE)).toEqual({
      ok: true,
      updates: [],
    })
  })

  test("changed columns come back as typed parameters", () => {
    expect(parseRowKeyValue("id: 1\nname: amy\nemail: amy@example.com\n", USERS, ["id"], ALICE)).toEqual({
      ok: true,
      updates: [{ column: "name", param: "amy" }, { column: "email", param: "amy@example.com" }],
    })
  })

  test("the primary key column is ignored even when edited in the file", () => {
    expect(parseRowKeyValue("id: 99\nname: alice\nemail: alice@example.com\n", USERS, ["id"], ALICE)).toEqual({
      ok: true,
      updates: [],
    })
  })

  test("NULL clears a nullable column and is case-sensitive", () => {
    expect(parseRowKeyValue("id: 1\nname: alice\nemail: NULL\n", USERS, ["id"], ALICE)).toEqual({
      ok: true,
      updates: [{ column: "email", param: null }],
    })
    /* lowercase `null` is a literal string, not SQL NULL */
    expect(parseRowKeyValue("id: 1\nname: alice\nemail: null\n", USERS, ["id"], ALICE)).toEqual({
      ok: true,
      updates: [{ column: "email", param: "null" }],
    })
  })

  test("missing columns are left unchanged", () => {
    expect(parseRowKeyValue("name: amy\n", USERS, ["id"], ALICE)).toEqual({
      ok: true,
      updates: [{ column: "name", param: "amy" }],
    })
  })

  test("empty value after the colon is a validation error naming the column", () => {
    expect(parseRowKeyValue("id: 1\nname: \n", USERS, ["id"], ALICE)).toEqual({
      ok: false,
      error: 'line 2: empty value for column "name"',
    })
    expect(parseRowKeyValue("name:   \n", USERS, ["id"], ALICE)).toEqual({
      ok: false,
      error: 'line 1: empty value for column "name"',
    })
  })

  test("unknown columns are refused with the line number", () => {
    expect(parseRowKeyValue("name: amy\nbogus: 1\n", USERS, ["id"], ALICE)).toEqual({
      ok: false,
      error: 'line 2: unknown column "bogus"',
    })
  })

  test("a line without a colon is malformed", () => {
    expect(parseRowKeyValue("name amy\n", USERS, ["id"], ALICE)).toEqual({
      ok: false,
      error: 'line 1: expected "column: value"',
    })
  })

  test("values containing colons stay intact (split on first colon only)", () => {
    expect(parseRowKeyValue('name: alice: the sequel\n', USERS, ["id"], ALICE)).toEqual({
      ok: true,
      updates: [{ column: "name", param: "alice: the sequel" }],
    })
  })

  test("NULL on a NOT NULL column is a validation error", () => {
    expect(parseRowKeyValue("id: 1\nname: NULL\nemail: NULL\n", USERS, ["id"], ALICE)).toEqual({
      ok: false,
      error: 'line 2: column "name" cannot be NULL',
    })
  })

  test("empty strings round-trip through the quoted literal", () => {
    expect(parseRowKeyValue('name: ""\n', USERS, ["id"], ALICE)).toEqual({
      ok: true,
      updates: [{ column: "name", param: "" }],
    })
    expect(parseRowKeyValue('id: 1\nname: ""\nemail: ""\n', USERS, ["id"], ALICE)).toEqual({
      ok: true,
      updates: [{ column: "name", param: "" }, { column: "email", param: "" }],
    })
  })

  test("a value that doesn't match its type is refused with the line number", () => {
    const ITEMS: ReadonlyArray<TableColumn> = [
      { name: "id", type: "INTEGER", nullable: false },
      { name: "quantity", type: "INTEGER", nullable: false },
    ]
    expect(parseRowKeyValue("id: 1\nquantity: abc\n", ITEMS, ["id"], { id: 1, quantity: 4 })).toEqual({
      ok: false,
      error: 'line 2: "quantity" expects a number',
    })
  })

  test("comment and blank lines are ignored", () => {
    expect(
      parseRowKeyValue(`${HDR_1}\n\n${HDR_2}\n${HDR_3}\nid: 1\n\nname: amy\n`, USERS, ["id"], ALICE)
    ).toEqual({ ok: true, updates: [{ column: "name", param: "amy" }] })
  })

  test("a file with only comments or blanks reports no changes", () => {
    expect(parseRowKeyValue("# nothing to see\n\n", USERS, ["id"], ALICE)).toEqual({
      ok: true,
      updates: [],
    })
  })

  test("a repeated column keeps the last value", () => {
    expect(parseRowKeyValue("name: amy\nname: zoe\n", USERS, ["id"], ALICE)).toEqual({
      ok: true,
      updates: [{ column: "name", param: "zoe" }],
    })
  })
})

describe("parseFieldValue", () => {
  test("numerics become numbers", () => {
    expect(parseFieldValue({ name: "q", type: "INTEGER", nullable: false }, "7")).toBe(7)
    expect(parseFieldValue({ name: "p", type: "REAL", nullable: false }, "2.5")).toBe(2.5)
  })

  test("an empty draft on a nullable column becomes NULL", () => {
    expect(parseFieldValue({ name: "note", type: "TEXT", nullable: true }, "")).toBeNull()
    expect(parseFieldValue({ name: "note", type: "TEXT", nullable: false }, "")).toBe("")
  })
})