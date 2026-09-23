import { test, expect } from "bun:test"
import { Effect } from "effect"
import { makeTheme } from "@/theme"
import { useKeyboard } from "@/lib/use-keyboard"
import App from "@/app"
import { renderApp } from "@test/support/render-ui"
import { freshConfigFile, resolveTestServices } from "@test/support/services-fixture"

test("probe uppercase key name", async () => {
  const services = await resolveTestServices(freshConfigFile())
  const events: string[] = []
  function Probe() {
    useKeyboard(e => { events.push(`${e.name}|shift=${e.shift}`) })
    return null
  }
  const setup = await renderApp(<Probe /> as unknown as Parameters<typeof renderApp>[0])
  await pressKeyA(setup)
  await setup.act(() => {})
  console.log("EVENTS:", events)
  setup.renderer.destroy()
})
