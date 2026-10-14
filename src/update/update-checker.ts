/**
 * The update checker as an Effect service, composed into the app's layer
 * graph in `src/runtime.ts` like every other service.
 *
 * Each operation is one Effect composed with `Effect.gen` — the check
 * pipeline (read store → throttle → fetch → compare → ignore-list → record)
 * never leaves the Effect world until the single `runFork` at the React
 * boundary. Outcomes a caller must branch on are values (`Option`,
 * `UpgradeOutcome`); only genuine failures ride the error channel.
 */
import { Context, Effect, Layer, Option } from "effect"
import { APP_VERSION } from "@/version"
import { compareVersions, fetchLatestRelease, type ReleaseInfo } from "@/update/check"
import { UpdateError } from "@/update/errors"
import { installRelease, type UpgradeDeps, type UpgradeOutcome } from "@/update/install"
import { readStore, defaultStorePath, recentlyChecked, writeStore, type UpdateStore } from "@/update/store"

/** Checks run at most this often unless the user explicitly asks (`:upgrade`). */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface UpdateCheckerService {
  /** The version this binary was built from. */
  readonly currentVersion: string
  /**
   * The pending update, if one survived throttling, comparison, and the
   * ignore list. Background policy lives here; the caller just branches.
   */
  readonly check: Effect.Effect<Option.Option<ReleaseInfo>, UpdateError>
  /** Always fetch, ignoring the throttle — for the explicit `:upgrade`. */
  readonly checkLatest: Effect.Effect<Option.Option<ReleaseInfo>, UpdateError>
  /** Silence this version across restarts. */
  readonly ignore: (version: string) => Effect.Effect<void, UpdateError>
  /** Download and install this release over the running binary. */
  readonly install: (release: ReleaseInfo) => Effect.Effect<UpgradeOutcome, UpdateError>
}

export class UpdateChecker extends Context.Tag("UpdateChecker")<UpdateChecker, UpdateCheckerService>() {}

export interface UpdateCheckerDeps {
  readonly storePath: string
  readonly execPath: string
  readonly platform: string
  readonly arch: string
  readonly fetchFn: typeof fetch
}

const recordCheck = (store: UpdateStore, path: string): Effect.Effect<void, UpdateError> =>
  writeStore({ ...store, lastCheckAt: new Date().toISOString() }, path)

const makeService = (deps: UpdateCheckerDeps): UpdateCheckerService => {
  const checkLatest = Effect.gen(function* () {
    const release = yield* fetchLatestRelease(deps.fetchFn)
    if (Option.isNone(release)) return Option.none()
    if (compareVersions(release.value.version, APP_VERSION) <= 0) return Option.none()
    const store = yield* readStore(deps.storePath)
    if (store.ignoredVersion === release.value.version) return Option.none()
    return release
  })

  return {
    currentVersion: APP_VERSION,

    check: Effect.gen(function* () {
      const store = yield* readStore(deps.storePath)
      if (recentlyChecked(store, CHECK_INTERVAL_MS)) return Option.none()
      const update = yield* checkLatest
      yield* recordCheck(store, deps.storePath)
      return update
    }),

    checkLatest,

    ignore: (version: string) =>
      Effect.gen(function* () {
        const store = yield* readStore(deps.storePath)
        yield* writeStore({ ...store, ignoredVersion: version }, deps.storePath)
      }),

    install: (release: ReleaseInfo) => {
      const upgrade: UpgradeDeps = {
        execPath: deps.execPath,
        platform: deps.platform,
        arch: deps.arch,
        fetchFn: deps.fetchFn,
      }
      return installRelease(release, upgrade)
    },
  }
}

export namespace UpdateChecker {
  /** Tests close over a stub fetch, a temp store path, and a fake binary. */
  export const layer = (deps: UpdateCheckerDeps): Layer.Layer<UpdateChecker> =>
    Layer.succeed(UpdateChecker, makeService(deps))

  /** Production: real fetch, real paths, the actual running binary. */
  export const layerDefault: Layer.Layer<UpdateChecker> = Layer.succeed(
    UpdateChecker,
    makeService({
      storePath: defaultStorePath(),
      execPath: process.execPath,
      platform: process.platform,
      arch: process.arch,
      fetchFn: fetch,
    })
  )
}
