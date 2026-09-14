import { testRender } from "@opentui/react/test-utils"
import type { TestRendererSetup } from "@opentui/core/testing"
import type { ReactNode } from "react"

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

export async function renderApp(node: ReactNode, options: { width?: number; height?: number } = {}): Promise<TestRendererSetup> {
  const setup = await testRender(node, {
    width: options.width ?? 80,
    height: options.height ?? 24,
  })
  // OpenTUI drives the React reconciler from its own native frame loop, which
  // runs outside React's act() scope. Disable the act environment so those
  // scheduled commits don't emit spurious "not wrapped in act(...)" warnings.
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  await setup.waitForVisualIdle()
  return setup
}