import { describe, expect, test } from "bun:test"
import App from "@/app"
import { makeTheme } from "@/theme"
import { renderApp } from "@test/support/render-ui"
import { freshConfigFile, resolveTestServices } from "@test/support/services-fixture"

describe("App", () => {
  test("renders without crashing", async () => {
    const services = await resolveTestServices(freshConfigFile())
    const setup = await renderApp(<App theme={makeTheme("dark")} services={services.services} />)

    const spans = setup.captureSpans()
    expect(spans.cols).toBe(88)
    expect(spans.rows).toBe(26)
    expect(setup.captureCharFrame()).toBeDefined()

    setup.renderer.destroy()
  })
})