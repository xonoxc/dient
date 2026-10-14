/**
 * Update UI state: the background check runs once on mount as a single
 * composed Effect (check → branch → toast), and every user action below is
 * likewise one `Effect.gen` forked exactly once. Toasts and React state are
 * `Effect.sync` steps *inside* the composition — nothing awaits a promise
 * mid-flow and no second Effect is ever run from a `.then`.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { Effect, Option } from "effect"
import { useDialog, useServices, useToasts } from "@/app-context"
import type { ReleaseInfo } from "@/update/check"
import { UpdateError } from "@/update/errors"
import type { UpgradeOutcome } from "@/update/install"

export type UpdatePhase = "unknown" | "checking" | "available" | "current"

export interface UpdateUiState {
  readonly phase: UpdatePhase
  readonly release: ReleaseInfo | null
  /** Fetch fresh and install: toasts every outcome, one fork. */
  readonly upgradeNow: () => void
  /** Silence the pending release across restarts, one fork. */
  readonly ignoreRelease: () => void
}

const UpdateUiContext = createContext<UpdateUiState | null>(null)

type InstallStep = UpgradeOutcome | { readonly _tag: "Failed"; readonly message: string }

export function UpdateProvider({ children }: { children?: ReactNode }) {
  const { updateChecker } = useServices()
  const toasts = useToasts()
  const dialog = useDialog()
  const [phase, setPhase] = useState<UpdatePhase>("unknown")
  const [release, setRelease] = useState<ReleaseInfo | null>(null)

  /* Background check, once: a silent failure resolves as "current" because a
     startup probe must never interrupt a session. */
  useEffect(() => {
    const program = Effect.gen(function* () {
      setPhase("checking")
      const update = yield* updateChecker.check.pipe(Effect.orElseSucceed(() => Option.none()))
      if (Option.isSome(update)) {
        const found = update.value
        setRelease(found)
        setPhase("available")
        toasts.push("info", `${found.tag} available — :upgrade to install, :ignore-update to skip`, 8000)
      } else {
        setPhase("current")
      }
    })
    Effect.runFork(program)
  }, [updateChecker, toasts])

  const upgradeNow = useCallback(() => {
    const program = Effect.gen(function* () {
      const latest = yield* updateChecker.checkLatest.pipe(
        Effect.catchAll((error: UpdateError) =>
          Effect.sync(() => {
            toasts.push("error", `could not check for updates: ${error.message}`)
            return Option.none() as Option.Option<ReleaseInfo>
          })
        )
      )
      if (Option.isNone(latest)) {
        toasts.push("info", `already on the latest (v${updateChecker.currentVersion})`)
        return
      }
      const target = latest.value
      setRelease(target)
      toasts.push("info", `downloading ${target.tag}…`, 15000)
      const outcome: InstallStep = yield* updateChecker
        .install(target)
        .pipe(
          Effect.catchAll((error: UpdateError) =>
            Effect.sync((): InstallStep => ({ _tag: "Failed", message: error.message }))
          )
        )
      if (outcome._tag === "Installed") {
        setPhase("current")
        toasts.push("success", `updated to ${target.tag} — quit (q) and relaunch to use it`, 10000)
        return
      }
      if (outcome._tag === "Failed") {
        toasts.push("error", `upgrade failed: ${outcome.message}`)
        return
      }
      /* No supported path on this machine: show the release notes and the
         direct download so the user can finish by hand. */
      const notes = target.notes.trim().slice(0, 400)
      const body = `${outcome.reason}.\n\n${target.pageUrl}\n${outcome.url}${notes ? `\n\n${notes}` : ""}`
      yield* Effect.promise(() => dialog.confirm({ title: `install ${target.tag} manually`, body, okLabel: "close" }))
    }).pipe(
      Effect.catchAll((error: UpdateError) =>
        Effect.sync(() => {
          toasts.push("error", `upgrade failed: ${error.message}`)
        })
      )
    )
    Effect.runFork(program)
  }, [updateChecker, toasts, dialog])

  const ignoreRelease = useCallback(() => {
    const program = Effect.gen(function* () {
      if (!release) {
        toasts.push("info", "no pending update to ignore")
        return
      }
      yield* updateChecker.ignore(release.version)
      setPhase("current")
      toasts.push("info", `ignoring ${release.tag} — will notify again on the next release`)
    }).pipe(
      Effect.catchAll((error: UpdateError) =>
        Effect.sync(() => {
          toasts.push("error", `could not ignore update: ${error.message}`)
        })
      )
    )
    Effect.runFork(program)
  }, [updateChecker, release, toasts])

  const value = useMemo<UpdateUiState>(
    () => ({ phase, release, upgradeNow, ignoreRelease }),
    [phase, release, upgradeNow, ignoreRelease]
  )
  return <UpdateUiContext.Provider value={value}>{children}</UpdateUiContext.Provider>
}

export function useUpdateUi(): UpdateUiState {
  const update = useContext(UpdateUiContext)
  if (!update) throw new Error("useUpdateUi() used outside of an <UpdateProvider>")
  return update
}
