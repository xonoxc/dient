/**
 * Self-upgrade: download the release binary for this machine and replace the
 * running executable with it.
 *
 * One Effect per operation, composed with `Effect.gen`; failures carry
 * `UpdateError`, while the expected alternative — no supported path, so the
 * user must download manually — is a value (`NeedsManual`), never an error.
 */
import { access, chmod, constants, mkdir, rename, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { Effect, Option } from "effect"
import { pickAsset, type ReleaseAsset, type ReleaseInfo } from "@/update/check"
import { UpdateError } from "@/update/errors"

export interface UpgradeDeps {
  /** `process.execPath` in the app; a scratch file in tests. */
  readonly execPath: string
  /** `process.platform` / `process.arch` in the app. */
  readonly platform: string
  readonly arch: string
  readonly fetchFn?: typeof fetch
}

export type UpgradeOutcome =
  | { readonly _tag: "Installed"; readonly version: string }
  | { readonly _tag: "NeedsManual"; readonly reason: string; readonly url: string }

/**
 * True only for compiled release binaries. Under `bun run` the exec path is
 * the bun runtime itself — replacing that would be vandalism, not an upgrade.
 */
export const isReleaseBuild = (execPath: string): boolean => !basename(execPath).startsWith("bun")

const downloadBytes = (url: string, fetchFn: typeof fetch): Effect.Effect<Uint8Array, UpdateError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetchFn(url),
      catch: cause => new UpdateError({ message: "download failed", cause }),
    })
    if (!response.ok) {
      return yield* Effect.fail(new UpdateError({ message: `download answered ${response.status}` }))
    }
    const buffer = yield* Effect.tryPromise({
      try: () => response.arrayBuffer(),
      catch: cause => new UpdateError({ message: "download failed", cause }),
    })
    return new Uint8Array(buffer)
  })

/* One stage of the install, each its own small Effect so the pipeline below
   reads as stages, not nested callbacks. */
const stageFile = (staged: string, bytes: Uint8Array): Effect.Effect<void, UpdateError> =>
  Effect.tryPromise({
    try: () => writeFile(staged, bytes),
    catch: cause => new UpdateError({ message: "could not stage the download", cause }),
  })

const makeExecutable = (staged: string): Effect.Effect<void, UpdateError> =>
  Effect.tryPromise({
    try: () => chmod(staged, 0o755),
    catch: cause => new UpdateError({ message: "could not mark the binary executable", cause }),
  })

const swapIntoPlace = (staged: string, target: string): Effect.Effect<void, UpdateError> =>
  Effect.tryPromise({
    try: () => rename(staged, target),
    catch: cause => new UpdateError({ message: "install failed", cause }),
  })

const ensureDir = (dir: string): Effect.Effect<void, UpdateError> =>
  Effect.tryPromise({
    try: () => mkdir(dir, { recursive: true }),
    catch: cause => new UpdateError({ message: "could not create install directory", cause }),
  })

const isWritable = (dir: string): Effect.Effect<boolean> =>
  Effect.tryPromise(() => access(dir, constants.W_OK)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false)
  )

/**
 * Replace `execPath` with the release's binary for this platform. The new
 * file lands beside the old one first (same directory, so the rename is
 * atomic), gains the execute bit, then swaps into place. Renaming over a
 * running Linux/macOS executable is safe; the user relaunches to run it.
 */
export const installRelease = (release: ReleaseInfo, deps: UpgradeDeps): Effect.Effect<UpgradeOutcome, UpdateError> =>
  Effect.gen(function* () {
    if (!isReleaseBuild(deps.execPath)) {
      return yield* Effect.fail(new UpdateError({ message: "upgrade needs a release binary — this is a dev session" }))
    }
    const asset: ReleaseAsset | null = pickAsset(release, deps.platform, deps.arch)
    if (!asset) {
      return {
        _tag: "NeedsManual",
        reason: "no binary for this platform in the release",
        url: release.pageUrl,
      } as const
    }
    const dir = dirname(deps.execPath)
    if (!(yield* isWritable(dir))) {
      return { _tag: "NeedsManual", reason: "cannot write to the install directory", url: asset.downloadUrl } as const
    }
    const staged = join(dir, `${basename(deps.execPath)}.new`)
    const bytes = yield* downloadBytes(asset.downloadUrl, deps.fetchFn ?? fetch)
    yield* ensureDir(dir)
    yield* stageFile(staged, bytes)
    yield* makeExecutable(staged)
    yield* swapIntoPlace(staged, deps.execPath)
    return { _tag: "Installed", version: release.version } as const
  })

/** Convenience for callers that only need "is there anything to upgrade to". */
export const upgradeTarget = (release: ReleaseInfo, platform: string, arch: string): Option.Option<ReleaseAsset> =>
  Option.fromNullable(pickAsset(release, platform, arch))
