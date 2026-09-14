/**
 * Native terminal theme.
 *
 * dient never hardcodes hex colors. Every surface is colored through semantic
 * tokens that resolve to OpenTUI RGBA values, and those in turn resolve to the
 * terminal's own palette:
 *
 *   - `text` and `bg` use `RGBA.defaultForeground()` / `RGBA.defaultBackground()`,
 *     which carry the "default" intent so they always match the terminal exactly.
 *   - Everything else uses `RGBA.fromIndex(slot)`, which carries the "indexed"
 *     intent so the token paints with the ANSI palette slot the terminal itself
 *     renders (Catppuccin, Dracula, Solarized, Nord, plain xterm, ...). No config,
 *     no detection guesswork.
 *
 * Dark/light only changes which way surface panels drift off the base background
 * (lighter in dark terminals, darker in light ones) — the ANSI slots stay stable
 * because they are relative to whatever palette is active.
 */
import { Context, Effect, Layer } from "effect"
import { RGBA } from "@opentui/core"

export type ThemeMode = "dark" | "light"

/**
 * Semantic color tokens. Components read these instead of hardcoding RGB, so a
 * palette change anywhere is a one-line change in `makeTheme`.
 */
export interface ThemeColors {
  readonly text: RGBA
  readonly textMuted: RGBA
  readonly textBright: RGBA
  readonly bg: RGBA
  readonly bgSurface: RGBA
  readonly bgHighlight: RGBA
  readonly border: RGBA
  readonly borderFocused: RGBA
  readonly error: RGBA
  readonly warning: RGBA
  readonly success: RGBA
  readonly info: RGBA
  readonly accent: RGBA
  readonly accentMuted: RGBA
  readonly selection: RGBA
}

export interface ThemeService {
  readonly mode: ThemeMode
  readonly colors: ThemeColors
  readonly color: <K extends keyof ThemeColors>(token: K) => ThemeColors[K]
}

export class Theme extends Context.Tag("Theme")<Theme, ThemeService>() {}

/**
 * The smallest surface a renderer must expose for dark/light detection. The
 * `CliRenderer` from `@opentui/core` satisfies this structurally: `themeMode`
 * is populated once the OSC 11 query answers, `waitForThemeMode` blocks until
 * it does (or times out).
 */
export interface ThemeDetector {
  readonly themeMode: ThemeMode | null
  readonly waitForThemeMode?: (timeoutMs?: number) => Promise<ThemeMode | null>
}

export const DEFAULT_THEME_MODE: ThemeMode = "dark"

/** How long to wait for the terminal to answer the theme-mode query. */
export const THEME_DETECT_TIMEOUT_MS = 150

/** How strongly surface panels drift off the base background. */
const SURFACE_TINT_AMOUNT = 0.08

/**
 * Overlay `overlay` on top of `base` by `amount` (0..1) in linear space. The
 * result is a solid color — the blend is baked, so consumers just pass it to
 * a border/background and never think about alpha.
 */
const blend = (base: RGBA, overlay: RGBA, amount: number): RGBA => {
  const [r, g, b] = base.map((value) => value)
  const [or, og, ob] = overlay.map((value) => value)
  return RGBA.fromValues(
    r + (or - r) * amount,
    g + (og - g) * amount,
    b + (ob - b) * amount,
  )
}

export const makeTheme = (mode: ThemeMode): ThemeService => {
  /*
   * The "default" intent keeps base tokens matched to the terminal at render
   * time; the snapshots only supply the RGB resolved before/without palette
   * detection. The mode picks the polarity so blending below is meaningful even
   * before OSC detection lands.
   */
  const isDark = mode === "dark"
  const text = RGBA.defaultForeground(isDark ? "#ffffff" : "#000000")
  const bg = RGBA.defaultBackground(isDark ? "#000000" : "#ffffff")
  const bgHighlight = RGBA.fromIndex(18)
  /*
   * Surface panels sit one step off the terminal background: a light gray tint
   * in dark terminals (drifts lighter), a black tint in light ones (drifts
   * darker).
   */
  const surfaceTint = RGBA.fromIndex(isDark ? 7 : 0)
  const colors: ThemeColors = {
    text,
    textMuted: RGBA.fromIndex(8),
    textBright: RGBA.fromIndex(15),
    bg,
    bgSurface: blend(bg, surfaceTint, SURFACE_TINT_AMOUNT),
    bgHighlight,
    border: RGBA.fromIndex(8),
    borderFocused: RGBA.fromIndex(12),
    error: RGBA.fromIndex(1),
    warning: RGBA.fromIndex(3),
    success: RGBA.fromIndex(2),
    info: RGBA.fromIndex(6),
    accent: RGBA.fromIndex(12),
    accentMuted: RGBA.fromIndex(4),
    selection: RGBA.fromIndex(8, bgHighlight),
  }
  return {
    mode,
    colors,
    color: (token) => colors[token],
  }
}

const normalizeMode = (mode: ThemeMode | null | undefined): ThemeMode =>
  mode === "dark" || mode === "light" ? mode : DEFAULT_THEME_MODE

/**
 * Resolve the active theme mode from the renderer. The immediate `themeMode`
 * wins; otherwise we ask `waitForThemeMode` once (guarded, with a timeout) and
 * fall back to `dark` if the terminal never answers.
 */
const detectMode = (detector: ThemeDetector): Effect.Effect<ThemeMode, never> =>
  Effect.gen(function* () {
    const immediate = detector.themeMode
    if (immediate === "dark" || immediate === "light") {
      return immediate
    }
    if (detector.waitForThemeMode) {
      const awaited = yield* Effect.tryPromise(() =>
        detector.waitForThemeMode!(THEME_DETECT_TIMEOUT_MS)
      ).pipe(Effect.catchAll(() => Effect.succeed(null)))
      return normalizeMode(awaited)
    }
    return DEFAULT_THEME_MODE
  })

export namespace Theme {
  /** A fixed-mode layer; used when the mode is known ahead of time (tests). */
  export const layer = (mode: ThemeMode = DEFAULT_THEME_MODE): Layer.Layer<Theme> =>
    Layer.succeed(Theme, makeTheme(mode))

  /** Auto-detects the terminal's dark/light mode and provides the theme. */
  export const layerDetect = (detector: ThemeDetector): Layer.Layer<Theme> =>
    Layer.effect(Theme, Effect.map(detectMode(detector), makeTheme))
}