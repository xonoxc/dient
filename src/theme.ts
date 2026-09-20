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
 *
 * Highlights follow the same rule as surface panels: `bgHighlight`/`selection`
 * drift off the terminal background toward the foreground color. That makes the
 * selected row read as a *lighter* band in dark terminals and a *darker* band in
 * light ones — always relative to the active colorscheme, never a hardcoded gray
 * that ignores the palette. Text on top keeps using the terminal's own contrast
 * slots (`textBright` on dark bands, `text` on light ones).
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
  /** Optional OSC palette probe; used to read the terminal's *real* ANSI colors. */
  readonly getPalette?: (options?: { timeout?: number; size?: number }) => Promise<{
    palette: ReadonlyArray<string | null>
    defaultForeground: string | null
    defaultBackground: string | null
  }>
}

/**
 * The terminal's actual palette, as reported by the OSC 4 / OSC 11 queries.
 * `null` entries mean the terminal refused to answer for that slot.
 */
export interface TerminalPalette {
  readonly palette?: ReadonlyArray<string | null>
  readonly defaultForeground?: string | null
  readonly defaultBackground?: string | null
}

export const DEFAULT_THEME_MODE: ThemeMode = "dark"

/** How long to wait for the terminal to answer the theme-mode query. */
export const THEME_DETECT_TIMEOUT_MS = 150

/** How long to wait for the OSC palette probe before falling back to defaults. */
export const THEME_PALETTE_TIMEOUT_MS = 300

/** How strongly surface panels drift off the base background. */
const SURFACE_TINT_AMOUNT = 0.08

/**
 * How strongly a selected row/cursor highlight drifts off the base background.
 * Deliberately ~2.5× the surface tint so the focused row stands out from idle
 * panels while still blending with the terminal's colorscheme (blend toward the
 * foreground color: lighter in dark terminals, darker in light ones).
 */
const HIGHLIGHT_TINT_AMOUNT = 0.18

/**
 * Overlay `overlay` on top of `base` by `amount` (0..1) in linear space. The
 * result is a solid color — the blend is baked, so consumers just pass it to
 * a border/background and never think about alpha.
 */
const blend = (base: RGBA, overlay: RGBA, amount: number): RGBA => {
  const [r, g, b] = base.map(value => value)
  const [or, og, ob] = overlay.map(value => value)
  return RGBA.fromValues(r + (or - r) * amount, g + (og - g) * amount, b + (ob - b) * amount)
}

export const makeTheme = (mode: ThemeMode, palette?: TerminalPalette): ThemeService => {
  /*
   * The "default" intent keeps base tokens matched to the terminal at render
   * time; the snapshots only supply the RGB resolved before/without palette
   * detection. When the OSC probe answered, those snapshots are the terminal's
   * *own* colors, so token slots paint exactly like the terminal would render
   * them (an indexed emitter re-maps the slot, a truecolor emitter uses the hex
   * — both land on the user's palette). The mode picks the polarity so blending
   * is meaningful even before OSC detection lands.
   */
  const isDark = mode === "dark"
  const slotHex = (index: number): string | undefined => palette?.palette?.[index] ?? undefined
  /* `indexed` intent plus the terminal's real hex for that slot. */
  const slot = (index: number): RGBA => RGBA.fromIndex(index, slotHex(index))
  const text = RGBA.defaultForeground(palette?.defaultForeground ?? (isDark ? "#ffffff" : "#000000"))
  const bg = RGBA.defaultBackground(palette?.defaultBackground ?? (isDark ? "#000000" : "#ffffff"))
  /*
   * The selected-row highlight is the background drifted toward the foreground
   * color — a light band in dark terminals, a dark band in light ones. Because
   * it blends with the terminal's *own* background+foreground, it follows the
   * active colorscheme instead of painting a fixed gray.
   */
  const highlight = blend(bg, text, HIGHLIGHT_TINT_AMOUNT)
  /*
   * Surface panels sit one step off the terminal background: a light gray tint
   * in dark terminals (drifts lighter), a black tint in light ones (drifts
   * darker).
   */
  const surfaceTint = slot(isDark ? 7 : 0)
  const colors: ThemeColors = {
    text,
    textMuted: slot(8),
    textBright: slot(15),
    bg,
    bgSurface: blend(bg, surfaceTint, SURFACE_TINT_AMOUNT),
    bgHighlight: highlight,
    border: slot(8),
    borderFocused: slot(12),
    error: slot(1),
    warning: slot(3),
    success: slot(2),
    info: slot(6),
    accent: slot(12),
    accentMuted: slot(4),
    selection: highlight,
  }
  return {
    mode,
    colors,
    color: token => colors[token],
  }
}

const normalizeMode = (mode: ThemeMode | null | undefined): ThemeMode =>
  mode === "dark" || mode === "light" ? mode : DEFAULT_THEME_MODE

/**
 * Probe the terminal's actual ANSI palette via OSC if the renderer supports it.
 * Any failure (dumb terminal, refused reply, timeout) yields no palette and the
 * theme falls back to the ANSI defaults — never crashes boot.
 */
const detectPalette = (detector: ThemeDetector): Effect.Effect<TerminalPalette | undefined, never> =>
  detector.getPalette
    ? Effect.tryPromise(() => detector.getPalette!({ size: 16, timeout: THEME_PALETTE_TIMEOUT_MS })).pipe(
        Effect.map(p => ({
          palette: p.palette,
          defaultForeground: p.defaultForeground,
          defaultBackground: p.defaultBackground,
        })),
        Effect.catchAll(() => Effect.succeed(undefined))
      )
    : Effect.succeed(undefined)

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
      const awaited = yield* Effect.tryPromise(() => detector.waitForThemeMode!(THEME_DETECT_TIMEOUT_MS)).pipe(
        Effect.catchAll(() => Effect.succeed(null))
      )
      return normalizeMode(awaited)
    }
    return DEFAULT_THEME_MODE
  })

export namespace Theme {
  /** A fixed-mode layer; used when the mode is known ahead of time (tests). */
  export const layer = (mode: ThemeMode = DEFAULT_THEME_MODE, palette?: TerminalPalette): Layer.Layer<Theme> =>
    Layer.succeed(Theme, makeTheme(mode, palette))

  /**
   * Auto-detects the terminal's dark/light mode and its real ANSI palette, then
   * provides the theme. Palette probing runs in parallel with mode detection so
   * the OSC round-trips don't stack on the critical path.
   */
  export const layerDetect = (detector: ThemeDetector): Layer.Layer<Theme> =>
    Layer.effect(
      Theme,
      Effect.all([detectMode(detector), detectPalette(detector)]).pipe(
        Effect.map(([mode, palette]) => makeTheme(mode, palette))
      )
    )
}
