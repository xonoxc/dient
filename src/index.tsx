import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { Effect } from "effect"
import App from "@/app"
import { Theme } from "@/theme"

const renderer = await createCliRenderer()

const theme = await Effect.runPromise(
  Effect.gen(function* () {
    return yield* Theme
  }).pipe(Effect.provide(Theme.layerDetect(renderer)))
)

createRoot(renderer).render(<App theme={theme} />)
