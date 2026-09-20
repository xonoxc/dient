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
    /* the highlight is a blend of the terminal bg + fg, not a palette slot */
    expect(colors.bgHighlight.intent).toBe("rgb")
  })

  test("indexed tokens resolve to the standard ANSI rgb values", () => {
    const colors = makeTheme("dark").colors
    expect(colors.textMuted.toInts()).toEqual([...ansi256IndexToRgb(8), 255])
    expect(colors.accent.toInts()).toEqual([...ansi256IndexToRgb(12), 255])
    expect(colors.error.toInts()).toEqual([...ansi256IndexToRgb(1), 255])
  })

  test("highlights drift a small, grayscale amount off the terminal bg toward the fg", () => {
    const colors = makeTheme("dark").colors
    expect(colors.bgHighlight.intent).toBe("rgb")
    const [r, g, b] = colors.bgHighlight.toInts()
    expect(r).toBe(g)
    expect(g).toBe(b)
    expect(r! > colors.bg.toInts()[0]!).toBe(true)
    expect(r! > colors.bgSurface.toInts()[0]!).toBe(true)
    expect(colors.selection.equals(colors.bgHighlight)).toBe(true)
  })

  test("bgSurface is the terminal bg blended with a palette tint", () => {
    const { bg, bgSurface } = makeTheme("dark").colors
    expect(bgSurface.intent).toBe("rgb")
    expect(bgSurface.equals(bg)).toBe(false)
  })

  test("selection snaps to the blend highlight color", () => {
    const { selection, bgHighlight } = makeTheme("dark").colors
    expect(selection.intent).toBe("rgb")
    expect(selection.equals(bgHighlight)).toBe(true)
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

describe("Theme real-ANSI-palette probing", () => {
  /* 16 valid grayscale entries with a distinctive bright-blue at slot 12 */
  const customPalette = Array.from(
    { length: 16 },
    (_, i) => `#${i.toString(16).padStart(2, "0")}${i.toString(16).padStart(2, "0")}${i.toString(16).padStart(2, "0")}`
  )
  const draculaBluePalette = [...customPalette.slice(0, 12), "#1e66f5", ...customPalette.slice(13)]

  test("token slots resolve to the terminal's own palette hexes when provided", () => {
    const colors = makeTheme("dark", { palette: draculaBluePalette }).colors
    expect(colors.accent.intent).toBe("indexed")
    expect(colors.accent.slot).toBe(12)
    expect(colors.accent.toInts()).toEqual([30, 102, 245, 255])
  })

  test("a real palette probe is wired through layerDetect", async () => {
    const theme = await resolveTheme({
      themeMode: "light",
      getPalette: async () => ({
        palette: draculaBluePalette,
        defaultForeground: "#fefefe",
        defaultBackground: "#010203",
      }),
    })
    expect(theme.mode).toBe("light")
    expect(theme.colors.accent.toInts()).toEqual([30, 102, 245, 255])
    expect(theme.colors.text.intent).toBe("default")
    expect(theme.colors.text.toInts()).toEqual([254, 254, 254, 255])
    expect(theme.colors.bg.toInts()).toEqual([1, 2, 3, 255])
  })

  test("falls back to the standard ANSI colors when a slot is missing", () => {
    const colors = makeTheme("dark", { palette: ["#000000", "#800000"] }).colors
    /* slot 12 not reported → default ANSI bright blue */
    expect(colors.accent.toInts()).toEqual([...ansi256IndexToRgb(12), 255])
  })

  test("a failing palette probe falls back to defaults and never breaks boot", async () => {
    const theme = await resolveTheme({
      themeMode: null,
      waitForThemeMode: async () => null,
      getPalette: async () => {
        throw new Error("suspended")
      },
    })
    expect(theme.mode).toBe(DEFAULT_THEME_MODE)
    expect(theme.colors.accent.toInts()).toEqual([...ansi256IndexToRgb(12), 255])
  })

  test("a renderer with no palette probe keeps the standard ANSI colors", async () => {
    const theme = await resolveTheme({ themeMode: "dark" })
    expect(theme.colors.accent.toInts()).toEqual([...ansi256IndexToRgb(12), 255])
  })
})
