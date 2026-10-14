/**
 * Cell viewer wrapping. The viewer hard-wraps the full value to the modal
 * width so a 160-character name reads top to bottom instead of running off
 * the panel edge.
 */
import { describe, expect, test } from "bun:test"
import { CELL_VIEWER_TEXT_WIDTH, wrapText } from "@/explorer/cell-viewer"

describe("wrapText", () => {
  test("a short value is one row", () => {
    expect(wrapText("alice", 68)).toEqual(["alice"])
  })

  test("a long value hard-wraps at the width", () => {
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"])
  })

  test("explicit newlines split first, then each paragraph wraps", () => {
    expect(wrapText("ab\ncdefg\nh", 4)).toEqual(["ab", "cdef", "g", "h"])
  })

  test("empty paragraphs keep their row so blank lines survive", () => {
    expect(wrapText("ab\n\ncd", 10)).toEqual(["ab", "", "cd"])
  })

  test("an empty value is one empty row, never zero", () => {
    expect(wrapText("", 10)).toEqual([""])
  })

  test("the modal text width leaves room for the surface padding", () => {
    expect(CELL_VIEWER_TEXT_WIDTH).toBeLessThan(72)
  })
})
