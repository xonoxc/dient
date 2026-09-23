/**
 * Row↔TSV serialization unit tests. The `$EDITOR` row editor hands the cursor
 * row to the user's editor as a two-line TSV (header + values) and parses the
 * edited file back into typed UPDATE parameters — primary key columns are
 * never written, unchanged cells are dropped, and values are validated against
 * the column type before anything is passed to the write path.
 */
import { describe, expect, test } from "bun:test"
import type { TableColumn } from "@/inspector/types"
import { parseTsvCells, parseRowTsv, parseFieldValue, serializeRowToTsv } from "@/editor/row-serialization"

const USERS: ReadonlyArray<TableColumn> = [
  { name: "id", type: "INTEGER", nullable: false },
  { name: "name", type: "TEXT", nullable: false },
  { name: "email", type: "TEXT", nullable: true },
]

const ALICE = { id: 1, name: "alice", email: "alice@example.com" }

describe("serializeRowToTsv", () => {
  test("writes a header line and one value line with column-aligned padding", () => {
    const tsv = serializeRowToTsv(USERS, ALICE)
    const lines = tsv.split("\n")
    /* The header and value lines are tab-separated with per-column padding. */
    const headers = lines[0]!.split("\t")
    const values = lines[1]!.split("\t")
    expect(headers.map(h => h.trimEnd())).toEqual(["id", "name", "email"])
    expect(values.map(v => v.trimEnd())).toEqual(["1", "alice", "alice@example.com"])
    /* Each column is padded to the same width in header and value rows. */
    for (let i = 0; i < headers.length; i++) {
      expect(headers[i]!.length).toBe(values[i]!.length)
    }
  })

  test("writes NULL as an unquoted empty cell and empty strings as \"\"", () => {
    const tsvNull = serializeRowToTsv(USERS, { id: 1, name: "bob", email: null })
    const nullValues = tsvNull.split("\n")[1]!.split("\t").map(v => v.trimEnd())
    expect(nullValues).toEqual(["1", "bob", ""])
    const tsvEmpty = serializeRowToTsv(USERS, { id: 1, name: "", email: "" })
    const emptyValues = tsvEmpty.split("\n")[1]!.split("\t").map(v => v.trimEnd())
    expect(emptyValues).toEqual(["1", '""', '""'])
  })

  test("quotes cells with tabs, newlines, or embedded quotes", () => {
    const quoted = 'say "hi"\nnext\tline'
    const tsv = serializeRowToTsv(USERS, { id: 1, name: quoted, email: null })
    /* Use parseTsvCells rather than naive split: the quoted cell itself
       contains tabs and newlines, so split would fragment it. */
    const lines = tsv.split("\n")
    const headerCells = parseTsvCells(lines[0]!)
    expect(headerCells.map(h => (h ?? "").trimEnd())).toEqual(["id", "name", "email"])
    /* The value line spans two raw newlines (the embedded one inside the
       quote plus the trailing line break), so re-join lines[1..] for parsing. */
    const valueLine = lines.slice(1, -1).join("\n")
    const valueCells = parseTsvCells(valueLine)
    expect((valueCells[0] ?? "").trimEnd()).toBe("1")
    expect(valueCells[1]).toBe(quoted)
  })
})

describe("parseTsvCells", () => {
  test("distinguishes NULL from an empty string", () => {
    expect(parseTsvCells("1\tabc\t")).toEqual(["1", "abc", null])
    expect(parseTsvCells('1\t""\t""')).toEqual(["1", "", ""])
  })

  test("unquotes embedded doubled quotes", () => {
    expect(parseTsvCells('a\t"say ""hi"""')).toEqual(["a", 'say "hi"'])
  })
})

describe("parseRowTsv", () => {
  test("an untouched file reports no changes", () => {
    expect(parseRowTsv(serializeRowToTsv(USERS, ALICE), USERS, ["id"], ALICE)).toEqual({
      ok: true,
      updates: [],
    })
  })

  test("changed cells come back as typed parameters keyed on the primary key", () => {
    const edited = "id\tname\temail\n1\tamy\tamy@example.com\n"
    expect(parseRowTsv(edited, USERS, ["id"], ALICE)).toEqual({
      ok: true,
      updates: [{ column: "name", param: "amy" }, { column: "email", param: "amy@example.com" }],
    })
  })

  test("the primary key column is ignored even when edited in the file", () => {
    const edited = "id\tname\temail\n99\talice\talice@example.com\n"
    expect(parseRowTsv(edited, USERS, ["id"], ALICE)).toEqual({ ok: true, updates: [] })
  })

  test("an unquoted empty cell on a nullable column clears it to NULL", () => {
    const edited = "id\tname\temail\n1\talice\t\n"
    expect(parseRowTsv(edited, USERS, ["id"], ALICE)).toEqual({
      ok: true,
      updates: [{ column: "email", param: null }],
    })
  })

  test("a field that doesn't match its type is refused, not parsed", () => {
    const ITEMS: ReadonlyArray<TableColumn> = [
      { name: "id", type: "INTEGER", nullable: false },
      { name: "quantity", type: "INTEGER", nullable: false },
    ]
    expect(parseRowTsv("id\tquantity\n1\tabc\n", ITEMS, ["id"], { id: 1, quantity: 4 })).toEqual({
      ok: false,
      error: '"quantity" expects a number',
    })
  })

  test("an empty file is reported as malformed", () => {
    expect(parseRowTsv("", USERS, ["id"], ALICE)).toEqual({
      ok: false,
      error: "the editor file needs a header row and one data row",
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