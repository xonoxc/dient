import { testRender } from "@opentui/react/test-utils"
import type { TestRendererSetup } from "@opentui/core/testing"
import { act } from "react"
import type { ReactNode } from "react"

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

/**
 * Render a React node into OpenTUI's test terminal and wait for the frame to
 * settle. OpenTUI drives the reconciler from its own native frame loop, which
 * runs outside React's act() scope, so the act environment is disabled to
 * avoid spurious "not wrapped in act(...)" warnings from queued commits.
 *
 * Kitty keyboard mode is on by default: a lone ESC byte only settles into a
 * keypress once the terminal parses a full protocol sequence, so tests that
 * press Escape need kitty sequences (as a modern terminal would send).
 */
export async function renderApp(
  node: ReactNode,
  options: { width?: number; height?: number; kittyKeyboard?: boolean } = {}
): Promise<TestRendererSetup> {
  const setup = await testRender(node, {
    width: options.width ?? 88,
    height: options.height ?? 26,
    kittyKeyboard: options.kittyKeyboard ?? true,
  })
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  await setup.waitForVisualIdle()
  return setup
}

/**
 * Press a sequence of keys inside a single act() batch and render the frame.
 * Each key is dispatched through mockInput.pressKey so named keys like Escape
 * and Return are encoded as full kitty protocol sequences (the same bytes a
 * modern terminal emits and OpenTUI parses in kitty mode).
 *
 * A key may carry a modifier prefix — `CTRL+n`, `SHIFT+a` — so tests can
 * exercise chords exactly as a terminal reports them.
 *
 * This mirrors a human typing quickly before React commits a frame, which is
 * why handlers that consume key events must live on always-mounted components
 * rather than on nodes that mount for the first time mid-batch.
 */
export async function pressKeys(setup: TestRendererSetup, keys: ReadonlyArray<string>): Promise<void> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  try {
    await act(async () => {
      for (const key of keys) {
        pressOne(setup, key)
      }
      setup.renderOnce()
      setup.flush()
    })
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  }
  await setup.waitForVisualIdle()
}

/** Dispatch one key, honouring a `CTRL+` / `SHIFT+` / `ALT+` prefix. */
function pressOne(setup: TestRendererSetup, key: string): void {
  const match = /^(CTRL|SHIFT|ALT)\+(.+)$/.exec(key)
  if (!match) {
    setup.mockInput.pressKey(key)
    return
  }
  const [, modifier, base] = match as unknown as [string, string, string]
  const modifiers =
    modifier === "CTRL"
      ? { ctrl: true as const }
      : modifier === "SHIFT"
        ? { shift: true as const }
        : { meta: true as const }
  setup.mockInput.pressKey(base, modifiers)
}

/**
 * US-layout keys that need Shift to produce the character, mapped to their
 * unshifted base key. A kitty-mode terminal reports these as the base key plus
 * a shift flag, so tests must press them the same way to exercise the
 * character-reconstruction path a real terminal takes.
 */
const SHIFTED_BASE: Readonly<Record<string, string>> = {
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
  "~": "`",
}

/**
 * Type a whole string the way a terminal delivers it: shifted characters as
 * their unshifted base key plus the shift modifier, letters as themselves
 * (uppercase letters shifted), and everything else verbatim. Typing the
 * literal character directly would skip the shift round-trip that real
 * terminals — and therefore the app's character reconstruction — rely on.
 */
export async function typeString(setup: TestRendererSetup, text: string): Promise<void> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  try {
    await act(async () => {
      for (const char of text) {
        const base = SHIFTED_BASE[char]
        if (base !== undefined) setup.mockInput.pressKey(base, { shift: true })
        else if (char >= "A" && char <= "Z") setup.mockInput.pressKey(char.toLowerCase(), { shift: true })
        /* A space is the literal " " byte. The mock's key table has no SPACE
           entry, so pressKey("space") would emit the five letters instead. */
        else setup.mockInput.pressKey(char)
      }
      setup.renderOnce()
      setup.flush()
    })
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  }
  await setup.waitForVisualIdle()
}

/**
 * Drive frames explicitly until a predicate matches. Used when a renderer
 * pause (e.g. an external `$EDITOR` suspend/resume session) leaves the
 * scheduler idle: commits still paint, but only when the loop is driven, so
 * `waitForFrame` (which waits for the scheduler and gives up when idle) would
 * miss them. Mirrors a real terminal where the loop runs continuously.
 */
export async function waitForFrameDriven(
  setup: TestRendererSetup,
  predicate: (frame: string) => boolean,
  maxPasses = 60
): Promise<string> {
  let last = ""
  for (let pass = 0; pass <= maxPasses; pass++) {
    await setup.renderOnce()
    await setup.waitForVisualIdle().catch(() => {})
    last = setup.captureCharFrame()
    if (predicate(last)) return last
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`frame predicate never matched while driving frames; last frame:\n${last}`)
}
