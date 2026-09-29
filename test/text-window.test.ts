/**
 * Single-line input windowing. A long pasted value must show its newest
 * characters (the cursor sits at the end of an append-only field), not the head
 * that OpenTUI's `truncate` would keep.
 */
import { describe, expect, test } from "bun:test"
import { windowTail } from "@/ui/text-window"

describe("windowTail", () => {
  test("a value that fits is returned unchanged", () => {
    expect(windowTail("game_service", 20)).toBe("game_service")
    expect(windowTail("", 5)).toBe("")
  })

  test("an exact fit is returned unchanged", () => {
    expect(windowTail("abcdef", 6)).toBe("abcdef")
  })

  test("a long value keeps its tail, not its head", () => {
    expect(windowTail("mysql://root:gameroot@localhost:3309/game_service", 12)).toBe("game_service")
  })

  test("a zero or negative budget shows nothing", () => {
    expect(windowTail("abc", 0)).toBe("")
    expect(windowTail("abc", -3)).toBe("")
  })

  test("a fractional budget floors to a whole number of cells", () => {
    expect(windowTail("abcdef", 3.9)).toBe("def")
  })

  test("the visible window never exceeds the budget", () => {
    const text = "x".repeat(500)
    expect(windowTail(text, 42).length).toBe(42)
  })
})
