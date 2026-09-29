/**
 * Text-entry character resolution. Terminals disagree about how shifted keys
 * are reported, so the resolver has to reconstruct the character from the key
 * name plus the shift flag — otherwise `@` arrives as `2` and a pasted
 * connection string comes out mangled.
 */
import { describe, expect, test } from "bun:test"
import { resolveTypedChar, isCommandKey, normalModeKey } from "@/ui/text-entry"

describe("resolveTypedChar", () => {
  test("an unshifted printable key is itself", () => {
    for (const char of "abzAZ09:/@._-?=&%#+") {
      expect(resolveTypedChar({ name: char, shift: false })).toBe(char)
    }
  })

  test("space arrives as a named key", () => {
    expect(resolveTypedChar({ name: "space" })).toBe(" ")
  })

  test("a shifted letter resolves to its uppercase form", () => {
    /* A legacy terminal reports `A` as name "a" with shift set. */
    expect(resolveTypedChar({ name: "a", shift: true })).toBe("A")
    expect(resolveTypedChar({ name: "z", shift: true })).toBe("Z")
    /* A kitty terminal may report the uppercase code directly. */
    expect(resolveTypedChar({ name: "S", shift: true })).toBe("S")
  })

  test("a shifted symbol resolves from its unshifted base key", () => {
    /* These are the characters a connection string is made of. */
    expect(resolveTypedChar({ name: "2", shift: true })).toBe("@")
    expect(resolveTypedChar({ name: ";", shift: true })).toBe(":")
    expect(resolveTypedChar({ name: "-", shift: true })).toBe("_")
    expect(resolveTypedChar({ name: "/", shift: true })).toBe("?")
    expect(resolveTypedChar({ name: "1", shift: true })).toBe("!")
    expect(resolveTypedChar({ name: "=", shift: true })).toBe("+")
    expect(resolveTypedChar({ name: "'", shift: true })).toBe('"')
  })

  test("every shifted symbol round-trips through its base key", () => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ["`", "~"],
      ["1", "!"],
      ["2", "@"],
      ["3", "#"],
      ["4", "$"],
      ["5", "%"],
      ["6", "^"],
      ["7", "&"],
      ["8", "*"],
      ["9", "("],
      ["0", ")"],
      ["-", "_"],
      ["=", "+"],
      ["[", "{"],
      ["]", "}"],
      ["\\", "|"],
      [";", ":"],
      ["'", '"'],
      [",", "<"],
      [".", ">"],
      ["/", "?"],
    ]
    for (const [base, shifted] of pairs) {
      expect(resolveTypedChar({ name: base, shift: true })).toBe(shifted)
      /* The already-shifted character must pass through unchanged, so a
         terminal that reports `@` directly is not turned into something else. */
      expect(resolveTypedChar({ name: shifted, shift: true })).toBe(shifted)
    }
  })

  test("control and navigation keys are never typed", () => {
    for (const name of ["return", "enter", "escape", "tab", "backspace", "up", "down", "left", "right", "home", "end"]) {
      expect(resolveTypedChar({ name })).toBeNull()
    }
  })

  test("a modifier chord is left to the screen's own bindings", () => {
    expect(resolveTypedChar({ name: "n", ctrl: true })).toBeNull()
    expect(resolveTypedChar({ name: "e", meta: true })).toBeNull()
    expect(resolveTypedChar({ name: "u", option: true })).toBeNull()
    expect(resolveTypedChar({ name: "a", super: true })).toBeNull()
  })

  test("a multi-byte name is not a character to insert", () => {
    expect(resolveTypedChar({ name: "f1" })).toBeNull()
    expect(resolveTypedChar({ name: "" })).toBeNull()
  })

  test("isCommandKey agrees with a null character", () => {
    expect(isCommandKey({ name: "return" })).toBe(true)
    expect(isCommandKey({ name: "q" })).toBe(false)
  })
})

describe("normalModeKey", () => {
  test("Shift+G reaches a NORMAL binding as G on every protocol", () => {
    /* Kitkat/legacy report the unshifted base plus the shift flag. */
    expect(normalModeKey({ name: "g", shift: true })).toBe("G")
    /* A terminal that reports the shifted byte directly. */
    expect(normalModeKey({ name: "G", shift: true })).toBe("G")
  })

  test("an unshifted letter stays lower case", () => {
    expect(normalModeKey({ name: "g" })).toBe("g")
    expect(normalModeKey({ name: "p" })).toBe("p")
  })

  test("Shift+P and the shifted `?` help key are reconstructed", () => {
    expect(normalModeKey({ name: "p", shift: true })).toBe("P")
    expect(normalModeKey({ name: "/", shift: true })).toBe("?")
  })

  test("command keys pass through so Enter, Escape, and arrows still match", () => {
    expect(normalModeKey({ name: "return" })).toBe("return")
    expect(normalModeKey({ name: "escape" })).toBe("escape")
    expect(normalModeKey({ name: "up" })).toBe("up")
    expect(normalModeKey({ name: "down" })).toBe("down")
  })

  test("a ctrl chord falls back to its name with the modifier intact", () => {
    const event = { name: "f", ctrl: true as const }
    expect(normalModeKey(event)).toBe("f")
    expect(event.ctrl).toBe(true)
  })

  test("space and digits keep the bindings menus expect", () => {
    expect(normalModeKey({ name: "space" })).toBe(" ")
    expect(normalModeKey({ name: "1" })).toBe("1")
    expect(normalModeKey({ name: "2" })).toBe("2")
  })
})
