/**
 * Fuzzy matcher unit tests — `fuzzyMatch` scoring/ordering and the accent
 * helper used to highlight matched characters in the finder overlay.
 */
import { describe, expect, test } from "bun:test"
import { fuzzyMatch, splitByPositions } from "@/finder/fuzzy"

describe("fuzzyMatch", () => {
  test("matches a contiguous subsequence in order", () => {
    const match = fuzzyMatch("ord", "orders")
    expect(match).not.toBeNull()
    expect(match!.positions).toEqual([0, 1, 2])
  })

  test("allows gaps but ranks them below contiguous hits", () => {
    const contiguous = fuzzyMatch("orders", "orders")
    const gapped = fuzzyMatch("ord", "unrelated-orders")
    expect(contiguous!.score).toBeGreaterThan(gapped!.score)
  })

  test("word-boundary matches outrank mid-word ones", () => {
    const boundary = fuzzyMatch("user", "user_profiles")
    const midWord = fuzzyMatch("user", "deusers")
    expect(boundary!.score).toBeGreaterThan(midWord!.score)
  })

  test("camel-hump matches outrank plain subsequences", () => {
    const camel = fuzzyMatch("ua", "userAddress")
    const plain = fuzzyMatch("ua", "useraddress")
    expect(camel!.score).toBeGreaterThan(plain!.score)
  })

  test("a match on earlier characters beats a late one", () => {
    const early = fuzzyMatch("n", "name")
    const late = fuzzyMatch("n", "phone")
    expect(early!.score).toBeGreaterThan(late!.score)
  })

  test("missing characters return null", () => {
    expect(fuzzyMatch("xyzzy", "orders")).toBeNull()
    expect(fuzzyMatch("", "orders")).not.toBeNull()
    expect(fuzzyMatch("", "")).not.toBeNull()
  })

  test("is case-insensitive", () => {
    const match = fuzzyMatch("ORD", "orders")
    expect(match).not.toBeNull()
    expect(match!.positions).toEqual([0, 1, 2])
  })
})

describe("splitByPositions", () => {
  test("splits text into matched and plain segments", () => {
    const match = fuzzyMatch("ord", "orders")
    const parts = splitByPositions("orders", match!.positions)
    expect(parts.map(p => p.text).join("")).toBe("orders")
    expect(parts).toEqual([
      { text: "ord", matched: true },
      { text: "ers", matched: false },
    ])
  })

  test("handles interior matches", () => {
    const match = fuzzyMatch("ers", "orders")
    const parts = splitByPositions("orders", match!.positions)
    expect(parts).toEqual([
      { text: "ord", matched: false },
      { text: "ers", matched: true },
    ])
  })
})