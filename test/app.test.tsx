import { describe, expect, test } from "bun:test"
import App from "@/app"
import { renderApp } from "@test/support/render-ui"

describe("App", () => {
  test("renders without crashing", async () => {
    const setup = await renderApp(<App />)

    const spans = setup.captureSpans()
    expect(spans.cols).toBe(80)
    expect(spans.rows).toBe(24)
    expect(setup.captureCharFrame()).toBeDefined()

    setup.renderer.destroy()
  })
})

