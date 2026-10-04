/**
 * Row ↔ `$EDITOR` file serialization unit tests, plus the clipboard format.
 *
 * The editor format is schema-ordered `column: value` lines; the clipboard
 * format is a padded Markdown table, because a yank is headed for a document
 * rather than back into the parser. These tests pin both shapes, and pin that
 * the Markdown one is aligned: every `|` in the same terminal column.
 *
 * The `$EDITOR` row editor hands
 * the cursor row to the user's editor as schema-ordered `column: value` lines
 * (with a comment header) and parses the edited file back into typed UPDATE
 * parameters — primary key columns are never written, unchanged columns are
 * dropped, and values are validated against the column type before anything is
 * passed to the write path. Malformed input fails with a line-numbered error
 * and never touches the database.
 */
import { describe, expect, test } from "bun:test"
import type { TableColumn } from "@/inspector/types"
import {
  parseFieldValue,
  parseRowKeyValue,
  serializeRowToKeyValue,
  serializeRowsToMarkdown,
} from "@/editor/row-serialization"

const USERS: ReadonlyArray<TableColumn> = [
  { name: "id", type: "INTEGER", nullable: false },
  { name: "name", type: "TEXT", nullable: false },
  { name: "email", type: "TEXT", nullable: true },
]

const ALICE = { id: 1, name: "alice", email: "alice@example.com" }
const BOB = { id: 2, name: "bob", email: "bob@example.com" }
const CAROL = { id: 3, name: "carol", email: "carol@example.com" }

const HDR_1 = "# Edit values using: column: value"
const HDR_2 = "# Use NULL explicitly for SQL NULL."
const HDR_3 = "# Missing columns are left unchanged."

describe("serializeRowToKeyValue", () => {
  test("writes the comment header and spaced column: value lines in schema order", () => {
    const text = serializeRowToKeyValue(USERS, ALICE)
    expect(text.split("\n")).toEqual([
      HDR_1,
      HDR_2,
      HDR_3,
      "",
      "id: 1",
      "",
      "name: alice",
      "",
      "email: alice@example.com",
      "",
    ])
  })

  test("writes SQL NULL explicitly and empty strings as quoted empties", () => {
    const nullRow = serializeRowToKeyValue(USERS, { id: 1, name: "bob", email: null })
    expect(nullRow).toContain("email: NULL")
    expect(nullRow).not.toContain("email: ∅")

    const emptyRow = serializeRowToKeyValue(USERS, { id: 1, name: "", email: "" })
    expect(emptyRow).toContain('name: ""')
    expect(emptyRow).toContain('email: ""')
  })

  test("derives the lines from the schema, not hardcoded names", () => {
    const ORDERS: ReadonlyArray<TableColumn> = [
      { name: "id", type: "INTEGER", nullable: false },
      { name: "placed_at", type: "TEXT", nullable: false },
    ]
    expect(serializeRowToKeyValue(ORDERS, { id: 3, placed_at: "2000-04-10" })).toContain("placed_at: 2000-04-10")
  })
})

/**
 * Where every *separator* sits in a line. A `|` preceded by a backslash is an
 * escaped value, not a column edge, so it is skipped — otherwise a row holding
 * a pipe would look misaligned when the table is perfectly well formed.
 */
const pipeColumns = (line: string): ReadonlyArray<number> => {
  const at: number[] = []
  for (let index = 0; index < line.length; index++) {
    if (line[index] !== "|") continue
    if (index > 0 && line[index - 1] === "\\") continue
    at.push(index)
  }
  return at
}

/**
 * Every drawn line of the table has its separators in the same columns and the
 * same total width — the "consistent column widths" requirement, stated as
 * something a test can check. This is what fails if the serializer ever goes
 * back to joining cells with ` | `.
 */
const expectAligned = (text: string): void => {
  const lines = text.split("\n").filter(line => line.length > 0)
  /* A header and a rule at minimum. */
  expect(lines.length).toBeGreaterThanOrEqual(2)
  const separators = pipeColumns(lines[0]!)
  /* Two edges, so at least one column. */
  expect(separators.length).toBeGreaterThanOrEqual(2)
  for (const line of lines) {
    expect(pipeColumns(line)).toEqual(separators)
    expect(line.length).toBe(lines[0]!.length)
  }
}

describe("serializeRowsToMarkdown", () => {
  test("a single row copies as a header, a rule and one padded row", () => {
    const text = serializeRowsToMarkdown(USERS, [ALICE])
    expect(text).toBe(
      [
        "| id   | name  | email             |",
        "| ---- | ----- | ----------------- |",
        "| 1    | alice | alice@example.com |",
        "",
      ].join("\n")
    )
    expectAligned(text)
    /* Header, rule, one row — a single-row copy still carries its columns. */
    expect(text.split("\n").filter(line => line.length > 0)).toHaveLength(3)
  })

  test("every selected row lands in one table, in row order, under one header", () => {
    const text = serializeRowsToMarkdown(USERS, [ALICE, BOB, CAROL])
    expectAligned(text)
    const lines = text.split("\n").filter(line => line.length > 0)
    expect(lines).toHaveLength(5)
    expect(lines[0]).toContain("id")
    /* Row order is the caller's, so a yank reads top to bottom as highlighted. */
    expect(lines[2]).toContain("alice")
    expect(lines[3]).toContain("bob")
    expect(lines[4]).toContain("carol")
    /* The header appears once, not once per row. */
    expect(lines.filter(line => line.startsWith("| id"))).toHaveLength(1)
  })

  test("the header is the schema's column names in schema order", () => {
    const ORDERS: ReadonlyArray<TableColumn> = [
      { name: "id", type: "INTEGER", nullable: false },
      { name: "placed_at", type: "TEXT", nullable: false },
    ]
    /* Derived from the schema, so a differently-named table needs no case. */
    expect(serializeRowsToMarkdown(ORDERS, [{ id: 3, placed_at: "2000-04-10" }]).split("\n")[0]).toBe(
      "| id   | placed_at  |"
    )
  })

  test("a column is as wide as its widest cell, so a wide value pads the header", () => {
    /* The header (`id`, 2) is narrower than the column it labels; the value
       decides the width and the header is padded out to meet it. */
    const wide = serializeRowsToMarkdown(USERS, [{ id: 123456789, name: "bo", email: "b@e.io" }])
    expectAligned(wide)
    const [header, rule, row] = wide.split("\n")
    expect(header).toBe(`| id        | name | email  |`)
    expect(rule).toBe(`| --------- | ---- | ------ |`)
    expect(row).toBe(`| 123456789 | bo   | b@e.io |`)
  })

  test("a column wider than its header pads the header on the right", () => {
    const text = serializeRowsToMarkdown(USERS, [{ id: 1, name: "alexandra", email: "a@e.io" }])
    expectAligned(text)
    expect(text.split("\n")[0]).toBe(`| id   | name      | email  |`)
    expect(text.split("\n")[2]).toBe(`| 1    | alexandra | a@e.io |`)
  })

  test("a one-character column is still MIN_COL_WIDTH wide, as the grid draws it", () => {
    const NARROW: ReadonlyArray<TableColumn> = [{ name: "n", type: "INTEGER", nullable: false }]
    const text = serializeRowsToMarkdown(NARROW, [{ n: 7 }])
    expectAligned(text)
    expect(text).toBe(["| n    |", "| ---- |", "| 7    |"].join("\n") + "\n")
  })

  test("a value wider than the display cap is copied whole, never truncated", () => {
    /* The grid clips a column wider than the viewport (MAX_COL_WIDTH); a
       clipboard that truncated its own values would be data loss instead. */
    const LONG = "x".repeat(60)
    const text = serializeRowsToMarkdown(USERS, [{ id: 1, name: LONG, email: "a@e.io" }])
    expectAligned(text)
    expect(text).toContain(LONG)
  })

  test("NULL copies as the grid draws it, and stays distinguishable from empty", () => {
    /* `∅` is what `formatCell` renders in the table, so the clipboard cannot
       disagree with the screen; an empty string is still an empty cell, so the
       two do not collapse into each other. */
    const text = serializeRowsToMarkdown(USERS, [{ id: 1, name: "", email: null }])
    expectAligned(text)
    expect(text.split("\n")[2]).toBe(`| 1    |      | ∅     |`)
  })

  test("values are formatted the way the grid formats them", () => {
    const FLAGS: ReadonlyArray<TableColumn> = [
      { name: "id", type: "INTEGER", nullable: false },
      { name: "active", type: "BOOLEAN", nullable: false },
      { name: "seen_at", type: "TIMESTAMP", nullable: true },
    ]
    const text = serializeRowsToMarkdown(FLAGS, [
      { id: 1, active: true, seen_at: new Date("2024-03-01T10:00:00.000Z") },
      { id: 2, active: false, seen_at: null },
    ])
    expectAligned(text)
    expect(text).toBe(
      [
        "| id   | active | seen_at                  |",
        "| ---- | ------ | ------------------------ |",
        "| 1    | true   | 2024-03-01T10:00:00.000Z |",
        "| 2    | false  | ∅                        |",
        "",
      ].join("\n")
    )
  })

  test("a pipe inside a value is escaped, so the column count holds", () => {
    /* Unescaped, this value would open two more columns and every row below it
       would be short by two cells. */
    const text = serializeRowsToMarkdown(USERS, [{ id: 1, name: "a|b", email: "c|d" }])
    expectAligned(text)
    expect(text).toContain("a\\|b")
    /* Two edges plus one separator per column boundary: the escaped pipes are
       values, not separators, so the column count survives them. */
    for (const line of text.split("\n").filter(line => line.length > 0)) {
      expect(pipeColumns(line)).toHaveLength(4)
    }
  })

  test("tabs and newlines inside a value are escaped, never emitted raw", () => {
    /* A literal newline would end the row and a literal tab would start a new
       column: one multi-line value would become two rows in the pasted table,
       which is worse than a visible escape. */
    const text = serializeRowsToMarkdown(USERS, [{ id: 1, name: "two\tcolumns", email: "line one\nline two" }])
    expectAligned(text)
    expect(text.split("\n").filter(line => line.length > 0)).toHaveLength(3)
    expect(text).toContain("two\\tcolumns")
    expect(text).toContain("line one\\nline two")
  })

  test("a carriage return is escaped too, so CRLF data cannot forge a row break", () => {
    const text = serializeRowsToMarkdown(USERS, [{ id: 1, name: "windows\r\nrows", email: "a" }])
    expectAligned(text)
    expect(text).toContain("windows\\r\\nrows")
  })

  test("no literal creeps in from the editor format", () => {
    const text = serializeRowsToMarkdown(USERS, [ALICE])
    expect(text).not.toContain('"')
    expect(text).not.toContain("#")
    expect(text).not.toContain("NULL")
    /* The rule row is dashes, not the old blank-line block separator. */
    expect(text).not.toContain("\n\n")
  })

  test("no rows still yields a header and a rule, so the shape survives", () => {
    /* `yankRows` refuses an empty yank, but the serializer should not emit a
       shape-less empty string if it is ever handed nothing. */
    const text = serializeRowsToMarkdown(USERS, [])
    expectAligned(text)
    expect(text.split("\n").filter(line => line.length > 0)).toHaveLength(2)
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
      updates: [
        { column: "name", param: "amy" },
        { column: "email", param: "amy@example.com" },
      ],
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
    expect(parseRowKeyValue("name: alice: the sequel\n", USERS, ["id"], ALICE)).toEqual({
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
      updates: [
        { column: "name", param: "" },
        { column: "email", param: "" },
      ],
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
    expect(parseRowKeyValue(`${HDR_1}\n\n${HDR_2}\n${HDR_3}\nid: 1\n\nname: amy\n`, USERS, ["id"], ALICE)).toEqual({
      ok: true,
      updates: [{ column: "name", param: "amy" }],
    })
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
