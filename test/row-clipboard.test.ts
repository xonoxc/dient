/**
 * Row yank unit tests. `Shift+V` in the table copies the row under the cursor,
 * or every row a visual selection spans, as the row editor's `column: value`
 * pairs minus the comment header. The selection is what makes it a *row* yank,
 * so the span rules (inclusive ends, reversed anchors, window clamping) are
 * pinned here rather than only through the keyboard.
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
  test("the clipboard text is key/value pairs with no comment header", () => {
    expect(yankRows(USERS, ROWS, 1, NONE)).toEqual({
      text: "id: 2\nname: bob\n",
      count: 1,
    })
  })

  test("a selection yields every row as its own block", () => {
    expect(yankRows(USERS, ROWS, 0, Option.some({ anchor: 0, head: 1 }))).toEqual({
      text: "id: 1\nname: alice\n\nid: 2\nname: bob\n",
      count: 2,
    })
  })

  test("nothing to copy is null, so the caller can say why", () => {
    expect(yankRows([], ROWS, 0, NONE)).toBeNull()
    expect(yankRows(USERS, [], 0, NONE)).toBeNull()
    expect(yankRows(USERS, ROWS, 9, NONE)).toBeNull()
  })
})
