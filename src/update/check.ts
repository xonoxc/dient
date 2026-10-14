/**
 * Update checking against GitHub Releases.
 *
 * Pure policy stays plain functions (`normalizeVersion`, `compareVersions`,
 * `assetNameFor`, `pickAsset`, `parseRelease`) — wrapping synchronous
 * computation in Effects would be ceremony, not composition. The single
 * effectful step, `fetchLatestRelease`, is an Effect failing with
 * `UpdateError`, so callers choose the silence policy by combinator:
 * `Effect.option` for the background check, `Effect.catchAll` for the
 * explicit `:upgrade`.
 *
 * The one contract that matters: `assetNameFor` must produce exactly the names
 * `.github/workflows/release.yml` uploads, or `:upgrade` finds nothing.
 */
import { Effect, Option } from "effect"
import { UpdateError } from "@/update/errors"

export interface ReleaseAsset {
  readonly name: string
  readonly downloadUrl: string
}

export interface ReleaseInfo {
  /** Tag as published (`v0.2.0`). */
  readonly tag: string
  /** Bare version (`0.2.0`), for comparing against the bundled one. */
  readonly version: string
  readonly notes: string
  readonly pageUrl: string
  readonly assets: ReadonlyArray<ReleaseAsset>
}

/** Strip the `v` tag prefix: tags are `v0.2.0`, versions are `0.2.0`. */
export const normalizeVersion = (tag: string): string => tag.trim().replace(/^[vV]/, "")

const numericCore = (version: string): { numbers: number[]; suffix: string | null } => {
  const [core = "", ...rest] = normalizeVersion(version).split("-")
  const suffix = rest.length > 0 ? rest.join("-") : null
  const numbers = core.split(".").map(part => {
    const n = Number.parseInt(part, 10)
    return Number.isNaN(n) ? 0 : n
  })
  return { numbers, suffix }
}

/**
 * Semver-ish comparison: numeric segments first (missing segments are 0, so
 * `1.2` equals `1.2.0`), then a release beats its own prerelease (`1.0` >
 * `1.0-rc.1`), and two prereleases compare lexically. Build metadata (`+…`)
 * is ignored — it never orders a release.
 */
export const compareVersions = (a: string, b: string): -1 | 0 | 1 => {
  const left = numericCore(a.split("+")[0] ?? "")
  const right = numericCore(b.split("+")[0] ?? "")
  const length = Math.max(left.numbers.length, right.numbers.length)
  for (let i = 0; i < length; i++) {
    const l = left.numbers[i] ?? 0
    const r = right.numbers[i] ?? 0
    if (l < r) return -1
    if (l > r) return 1
  }
  if (left.suffix === right.suffix) return 0
  if (left.suffix === null) return 1
  if (right.suffix === null) return -1
  return left.suffix < right.suffix ? -1 : 1
}

/** Asset name for this machine, or null when the platform has no release binary. */
export const assetNameFor = (platform: string, arch: string): string | null => {
  const os = platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : null
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null
  if (!os || !cpu) return null
  return `dient-${os}-${cpu}`
}

/** The release's asset for this machine, if it published one. */
export const pickAsset = (release: ReleaseInfo, platform: string, arch: string): ReleaseAsset | null => {
  const name = assetNameFor(platform, arch)
  if (!name) return null
  return release.assets.find(asset => asset.name === name) ?? null
}

interface GitHubReleaseResponse {
  readonly tag_name?: string
  readonly body?: string | null
  readonly html_url?: string
  readonly draft?: boolean
  readonly prerelease?: boolean
  readonly assets?: ReadonlyArray<{ readonly name?: string; readonly browser_download_url?: string }>
}

/** Parse one `/releases/latest` payload. None when it is a draft, a
    prerelease, or missing the tag the comparison needs. */
export const parseRelease = (payload: GitHubReleaseResponse): Option.Option<ReleaseInfo> => {
  if (payload.draft === true || payload.prerelease === true) return Option.none()
  const tag = payload.tag_name
  if (!tag) return Option.none()
  const assets: ReleaseAsset[] = []
  for (const asset of payload.assets ?? []) {
    if (asset.name && asset.browser_download_url) {
      assets.push({ name: asset.name, downloadUrl: asset.browser_download_url })
    }
  }
  return Option.some({
    tag,
    version: normalizeVersion(tag),
    notes: payload.body ?? "",
    pageUrl: payload.html_url ?? "",
    assets,
  })
}

export const LATEST_RELEASE_URL = "https://api.github.com/repos/xonoxc/dient/releases/latest"

/**
 * Fetch the latest stable release: None when there is none, failure with
 * `UpdateError` when the network or payload misbehaves. Callers pick the
 * silence policy — the background check folds failure to None, `:upgrade`
 * reports it.
 */
export const fetchLatestRelease = (
  fetchFn: typeof fetch = fetch
): Effect.Effect<Option.Option<ReleaseInfo>, UpdateError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetchFn(LATEST_RELEASE_URL, { headers: { Accept: "application/vnd.github+json" } }),
      catch: cause => new UpdateError({ message: "could not reach github releases", cause }),
    })
    if (!response.ok) {
      return yield* Effect.fail(new UpdateError({ message: `github releases answered ${response.status}` }))
    }
    const payload = (yield* Effect.tryPromise({
      try: () => response.json(),
      catch: cause => new UpdateError({ message: "github releases answered garbage", cause }),
    })) as GitHubReleaseResponse
    return parseRelease(payload)
  })
