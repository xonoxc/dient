import { testRender } from "@opentui/react/test-utils"
import type { TestRendererSetup } from "@opentui/core/testing"
import type { ReactNode } from "react"

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

/**
 * Render a React node into OpenTUI's test terminal and wait for the frame to
 * settle. OpenTUI drives the reconciler from its own native frame loop, which
 * runs outside React's act() scope, so the act environment is disabled to
 * avoid spurious "not wrapped in act(...)" warnings from queued commits.
 */
export async function renderApp(
  node: ReactNode,
  options: { width?: number; height?: number } = {}
): Promise<TestRendererSetup> {
  const setup = await testRender(node, {
    width: options.width ?? 80,
    height: options.height ?? 24,
  })
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  await setup.waitForVisualIdle()
  return setup
}