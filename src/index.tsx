import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { Effect } from "effect"
import App from "@/app"
import { Theme } from "@/theme"
import { resolveAppServices } from "@/runtime"

const renderer = await createCliRenderer()

const theme = await Effect.runPromise(
  Effect.gen(function* () {
    return yield* Theme
  }).pipe(Effect.provide(Theme.layerDetect(renderer)))
)

/*
 * Build every service inside a scope that lives for the whole process. The
 * program never completes (`Effect.never`), so the ConfigStore's SQLite client
 * and any driver pools stay open until the terminal session ends. React hooks
 * call the extracted service objects directly, outside the Effect scope.
 */
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* resolveAppServices()
      yield* Effect.sync(() => createRoot(renderer).render(<App services={services} theme={theme} />))
      yield* Effect.never
    })
  )
)
