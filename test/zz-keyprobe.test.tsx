import { test, expect } from "bun:test"
import { useKeyboard } from "@dient/react"
import { renderApp } from "./support/render-ui"

function Probe() {
  useKeyboard(e => {
    globalThis.__lastKey = `${e.name}|shift=${e.shift}|seq=${JSON.stringify(e.sequence)}`
  })
  return null
}

test("probe key names", async () => {
  const setup = await renderApp(<Probe />)
  await setup.mockInput.pressKey("A")
  await setup.pressKeys(["RETURN"]) // flush
  await setup.flush()
  console.log("probe A:", globalThis.__lastKey)
  await setup.mockInput.pressKey("a", { shift: true })
  await setup.pressKeys(["RETURN"])
  await setup.flush()
  console.log("probe a+shift:", globalThis.__lastKey)
  await setup.mockInput.pressKey("G")
  await setup.pressKeys(["RETURN"])
  await setup.flush()
  console.log("probe G:", globalThis.__lastKey)
  setup.renderer.destroy()
})
