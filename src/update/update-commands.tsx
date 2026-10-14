/**
 * Update `:` commands. Each `run` builds one Effect and forks it once —
 * `:version` is a single `Effect.sync` toast, while `:upgrade` and
 * `:ignore-update` delegate to the provider's composed programs.
 */
import { Effect } from "effect"
import { useCommand } from "@/app-context"
import { useToasts } from "@/app-context"
import { APP_VERSION } from "@/version"
import { useUpdateUi } from "@/update/update-provider"

export function UpdateCommands() {
  const toasts = useToasts()
  const update = useUpdateUi()

  useCommand({
    id: "update:version",
    help: ":version — show the app version",
    match: text => text.trim() === "version",
    run: () => {
      Effect.runFork(Effect.sync(() => toasts.push("info", `dient v${APP_VERSION}`)))
    },
  })
  useCommand({
    id: "update:upgrade",
    help: ":upgrade — install the pending update",
    match: text => text.trim() === "upgrade",
    run: () => update.upgradeNow(),
  })
  useCommand({
    id: "update:ignore",
    help: ":ignore-update — skip the pending update",
    match: text => text.trim() === "ignore-update",
    run: () => update.ignoreRelease(),
  })

  return null
}
