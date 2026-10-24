import { describe, expect, test } from "bun:test"
import { paneIndexForKey } from "@/ui/pane-keys"

describe("paneIndexForKey", () => {
  test("numbers panes left to right from 1", () => {
    expect(paneIndexForKey({ name: "1" }, 2)).toBe(0)
    expect(paneIndexForKey({ name: "2" }, 2)).toBe(1)
  })

  test("ignores numbers past the pane count", () => {
    expect(paneIndexForKey({ name: "0" }, 2)).toBeNull()
    expect(paneIndexForKey({ name: "3" }, 2)).toBeNull()
    expect(paneIndexForKey({ name: "2" }, 1)).toBeNull()
  })

  test("ignores chords and shifted digits", () => {
    expect(paneIndexForKey({ name: "1", ctrl: true }, 2)).toBeNull()
    expect(paneIndexForKey({ name: "2", meta: true }, 2)).toBeNull()
    expect(paneIndexForKey({ name: "1", shift: true }, 2)).toBeNull()
    expect(paneIndexForKey({ name: "2", option: true }, 2)).toBeNull()
  })

  test("ignores non-digit keys", () => {
    expect(paneIndexForKey({ name: "q" }, 2)).toBeNull()
    expect(paneIndexForKey({ name: "enter" }, 2)).toBeNull()
    expect(paneIndexForKey({ name: " " }, 2)).toBeNull()
  })
})
