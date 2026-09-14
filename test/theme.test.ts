import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { ansi256IndexToRgb, RGBA } from "@opentui/core"
import { DEFAULT_THEME_MODE, Theme, makeTheme } from "@/theme"
import type { ThemeDetector, ThemeService } from "@/theme"

const resolveTheme = (detector: ThemeDetector): Promise<ThemeService> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* Theme
    }).pipe(Effect.provide(Theme.layerDetect(detector)))
  )

const resolveLayer = (layer: Layer.Layer<Theme>): Promise<ThemeService> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* Theme
    }).pipe(Effect.provide(layer))
  )

describe("Theme tokens", () => {
  test("base text/bg carry the default intent so they match the terminal", () => {
    const { text, bg } = makeTheme("dark").colors
    expect(text.intent).toBe("default")
    expect(bg.intent).toBe("default")
    expect(text.toInts()).toEqual([255, 255, 255, 255])
    expect(bg.toInts()).toEqual([0, 0, 0, 255])
  })

  test("semantic tokens map to the planned ANSI palette slots", () => {
    const colors = makeTheme("dark").colors
    expect(colors.textMuted).toMatchObject({ intent: "indexed", slot: 8 })
    expect(colors.textBright).toMatchObject({ intent: "indexed", slot: 15 })
    expect(colors.border).toMatchObject({ intent: "indexed", slot: 8 })
    expect(colors.borderFocused).toMatchObject({ intent: "indexed", slot: 12 })
    expect(colors.error).toMatchObject({ intent: "indexed", slot: 1 })
    expect(colors.warning).toMatchObject({ intent: "indexed", slot: 3 })
    expect(colors.success).toMatchObject({ intent: "indexed", slot: 2 })
    expect(colors.info).toMatchObject({ intent: "indexed", slot: 6 })
    expect(colors.accent).toMatchObject({ intent: "indexed", slot: 12 })
    expect(colors.accentMuted).toMatchObject({ intent: "indexed", slot: 4 })
    expect(colors.bgHighlight).toMatchObject({ intent: "indexed", slot: 18 })
  })

  test("indexed tokens resolve to the standard ANSI rgb values", () => {
    const colors = makeTheme("dark").colors
    expect(colors.textMuted.toInts()).toEqual([...ansi256IndexToRgb(8), 255])
    expect(colors.accent.toInts()).toEqual([...ansi256IndexToRgb(12), 255])
    expect(colors.error.toInts()).toEqual([...ansi256IndexToRgb(1), 255])
  })

  test("bgSurface is the terminal bg blended with a palette tint", () => {
    const { bg, bgSurface } = makeTheme("dark").colors
    expect(bgSurface.intent).toBe("rgb")
    expect(bgSurface.equals(bg)).toBe(false)
  })

  test("selection snaps to the highlight color while keeping its slot", () => {
    const { selection, bgHighlight } = makeTheme("dark").colors
    expect(selection.intent).toBe("indexed")
    expect(selection.slot).toBe(8)
    expect(selection.toInts()).toEqual(bgHighlight.toInts())
  })

  test("light mode drifts surface panels darker, dark mode lighter", () => {
    const dark = makeTheme("dark").colors
    const light = makeTheme("light").colors
    expect(dark.bg.toInts()).toEqual([0, 0, 0, 255])
    expect(dark.bgSurface.toInts()[0]! > dark.bg.toInts()[0]!).toBe(true)
    expect(light.bgSurface.toInts()[0]! < light.bg.toInts()[0]!).toBe(true)
  })

  test("color() accessor returns the matching token", () => {
    const theme = makeTheme("dark")
    expect(theme.color("accent").equals(theme.colors.accent)).toBe(true)
    expect(theme.color("borderFocused").equals(theme.colors.borderFocused)).toBe(true)
  })
})

describe("Theme dark/light detection", () => {
  test("detects a dark terminal from the renderer theme mode", async () => {
    const theme = await resolveTheme({ themeMode: "dark" })
    expect(theme.mode).toBe("dark")
  })

  test("detects a light terminal from the renderer theme mode", async () => {
    const theme = await resolveTheme({ themeMode: "light" })
    expect(theme.mode).toBe("light")
  })

  test("awaits the theme-mode query when the mode is not yet known", async () => {
    const theme = await resolveTheme({ themeMode: null, waitForThemeMode: async () => "light" })
    expect(theme.mode).toBe("light")
  })

  test("falls back to dark when the terminal does not answer", async () => {
    const theme = await resolveTheme({ themeMode: null, waitForThemeMode: async () => null })
    expect(theme.mode).toBe(DEFAULT_THEME_MODE)
  })

  test("falls back to dark when the renderer exposes no detection", async () => {
    const theme = await resolveTheme({ themeMode: null })
    expect(theme.mode).toBe(DEFAULT_THEME_MODE)
  })

  test("survives a failing theme-mode query", async () => {
    const theme = await resolveTheme({
      themeMode: null,
      waitForThemeMode: async () => {
        throw new Error("renderer not started")
      },
    })
    expect(theme.mode).toBe(DEFAULT_THEME_MODE)
  })

  test("fixed-mode layer builds the requested theme", async () => {
    const theme = await resolveLayer(Theme.layer("light"))
    expect(theme.mode).toBe("light")
  })
})