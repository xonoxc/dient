/**
 * Row yank unit tests. `y` in the table copies the row under the cursor, or
 * every row a visual selection spans, as TSV with a header line. The selection
 * is what makes it a *row* yank, so the span rules (inclusive ends, reversed
 * anchors, window clamping) are pinned here rather than only through the
 * keyboard.
 */
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { TableColumn } from "@/inspector/types"
import { rowsForYank, yankRows } from "@/editor/row-clipboard"

const USERS: ReadonlyArray<TableColumn> = [
  { name: "id", type: "INTEGER", nullable: false },
  { name: "name", type: "TEXT", nullable: false },
]

const ALICE = { id: 1, name: "alice" }
const BOB = { id: 2, name: "bob" }
const CAROL = { id: 3, name: "carol" }
const ROWS: ReadonlyArray<Record<string, unknown>> = [ALICE, BOB, CAROL]

const NONE = Option.none()

describe("rowsForYank", () => {
  test("with no selection it is the cursor row alone", () => {
    expect(rowsForYank(ROWS, 1, NONE)).toEqual([BOB])
  })

  test("a selection covers both endpoints, cursor moves included", () => {
    const selection = Option.some({ anchor: 0, head: 2 })
    expect(rowsForYank(ROWS, 0, selection)).toEqual(ROWS)
  })

  test("a reversed selection yanks the same rows in row order", () => {
    expect(rowsForYank(ROWS, 0, Option.some({ anchor: 2, head: 0 }))).toEqual(ROWS)
  })

  test("a one-row selection still copies that row", () => {
    expect(rowsForYank(ROWS, 2, Option.some({ anchor: 2, head: 2 }))).toEqual([CAROL])
  })

  test("the span never reaches past the loaded window", () => {
    expect(rowsForYank(ROWS, 0, Option.some({ anchor: 1, head: 99 }))).toEqual([BOB, CAROL])
  })

  test("a cursor past the end yields nothing rather than a crash", () => {
    expect(rowsForYank(ROWS, 9, NONE)).toEqual([])
    expect(rowsForYank([], 0, NONE)).toEqual([])
  })
})

describe("yankRows", () => {
  test("a single-row yank is a one-row table, header and rule included", () => {
    /* Sized to the rows actually copied: only `bob` is in this yank, so `name`
       is four wide (`name` itself) rather than five as it would be over all
       three rows. The clipboard is a table of what was copied, not of the page. */
    expect(yankRows(USERS, ROWS, 1, NONE)).toEqual({
      text: "| id   | name |\n| ---- | ---- |\n| 2    | bob  |\n",
      count: 1,
    })
  })

  test("a selection yields one table with every row under a single header", () => {
    expect(yankRows(USERS, ROWS, 0, Option.some({ anchor: 0, head: 1 }))).toEqual({
      text: "| id   | name  |\n" + "| ---- | ----- |\n" + "| 1    | alice |\n" + "| 2    | bob   |\n",
      count: 2,
    })
  })

  test("nothing to copy is null, so the caller can say why", () => {
    expect(yankRows([], ROWS, 0, NONE)).toBeNull()
    expect(yankRows(USERS, [], 0, NONE)).toBeNull()
    expect(yankRows(USERS, ROWS, 9, NONE)).toBeNull()
  })
})
