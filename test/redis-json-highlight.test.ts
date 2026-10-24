import { describe, expect, test } from "bun:test"
import { highlightJsonLines, tokenizeJson } from "@/redis/json-highlight"

describe("JSON highlighting", () => {
  test("classifies keys, values, literals, numbers and punctuation", () => {
    const tokens = tokenizeJson(
      JSON.stringify({ id: 1, name: "Ada", active: true, none: null, tags: ["redis"] }, null, 2)
    )
    const kinds = new Map(tokens.map(token => [token.text, token.kind]))

    expect(kinds.get('"id"')).toBe("key")
    expect(kinds.get('"name"')).toBe("key")
    expect(kinds.get('"Ada"')).toBe("string")
    expect(kinds.get("1")).toBe("number")
    expect(kinds.get("true")).toBe("literal")
    expect(kinds.get("null")).toBe("literal")
    expect(kinds.get('"redis"')).toBe("string")
    expect(kinds.get(":")).toBe("punctuation")
    expect(kinds.get("[")).toBe("punctuation")
  })

  test("wraps long strings without losing their color", () => {
    const value = "abcdefghijklmnopqrstuvwx"
    const lines = highlightJsonLines(JSON.stringify({ name: value }, null, 2), 10)
    const stringSegments = lines
      .flat()
      .filter(segment => segment.kind === "string")
      .map(segment => segment.text)
      .join("")

    expect(stringSegments).toContain(value)
    for (const line of lines) {
      expect(line.reduce((width, segment) => width + segment.text.length, 0)).toBeLessThanOrEqual(10)
    }
  })

  test("keeps the document's newlines and empty lines", () => {
    const lines = highlightJsonLines('{\n\n  "a": 1\n}', 80)
    expect(lines.map(line => line.map(segment => segment.text).join(""))).toEqual(["{", "", '  "a": 1', "}"])
    const key = lines[2]?.find(segment => segment.kind === "key")
    expect(key?.text).toBe('"a"')
  })
})
