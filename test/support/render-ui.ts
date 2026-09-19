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
 * This mirrors a human typing quickly before React commits a frame, which is
 * why handlers that consume key events must live on always-mounted components
 * rather than on nodes that mount for the first time mid-batch.
 */
export async function pressKeys(
  setup: TestRendererSetup,
  keys: ReadonlyArray<string>
): Promise<void> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  try {
    await act(async () => {
      for (const key of keys) {
        setup.mockInput.pressKey(key)
      }
      setup.renderOnce()
      setup.flush()
    })
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  }
  await setup.waitForVisualIdle()
}