/**
 * Update checker tests. Pure policy asserts directly; every effectful path
 * runs one composed `Effect.gen` per test through a single `runPromise` —
 * the test runner is inherently promise-based, so the harness interop is one
 * jump while everything under test stays composed Effects.
 *
 * Service tests build a test layer: stub fetch, temp store, fake binary. No
 * test touches the network, the real home directory, or a real executable.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { mkdtempSync } from "node:fs"
import { readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assetNameFor,
  compareVersions,
  normalizeVersion,
  parseRelease,
  pickAsset,
  type ReleaseInfo,
} from "@/update/check"
import { recentlyChecked, readStore, writeStore } from "@/update/store"
import { installRelease, isReleaseBuild } from "@/update/install"
import { UpdateChecker } from "@/update/update-checker"
import { APP_VERSION } from "@/version"

const release = (overrides: Partial<ReleaseInfo> = {}): ReleaseInfo => ({
  tag: "v0.2.0",
  version: "0.2.0",
  notes: "notes",
  pageUrl: "https://github.com/xonoxc/dient/releases/tag/v0.2.0",
  assets: [
    { name: "dient-linux-x64", downloadUrl: "https://example.com/dient-linux-x64" },
    { name: "dient-darwin-arm64", downloadUrl: "https://example.com/dient-darwin-arm64" },
  ],
  ...overrides,
})

const stubFetch = (payload: unknown, ok = true): typeof fetch =>
  (async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
    arrayBuffer: async () => new TextEncoder().encode("BINARY").buffer,
  })) as unknown as typeof fetch

const testDeps = (overrides: Record<string, unknown> = {}) => ({
  storePath: join(mkdtempSync(join(tmpdir(), "dient-update-")), "update.json"),
  execPath: join(tmpdir(), "bun-fake-binary"),
  platform: "linux",
  arch: "x64",
  fetchFn: stubFetch({ tag_name: `v${APP_VERSION}`, assets: [] }),
  ...overrides,
})

/** Run one composed Effect; the single promise jump each test is allowed. */
const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

describe("compareVersions", () => {
  test("orders numeric segments", () => {
    expect(compareVersions("0.2.0", "0.1.0")).toBe(1)
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1)
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0)
  })

  test("ignores the v tag prefix and treats missing segments as zero", () => {
    expect(compareVersions("v1.2", "1.2.0")).toBe(0)
    expect(compareVersions("v10.0.0", "v9.9.9")).toBe(1)
  })

  test("ranks a release above its own prerelease", () => {
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1)
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1)
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.1")).toBe(1)
  })

  test("ignores build metadata", () => {
    expect(compareVersions("1.0.0+build.1", "1.0.0")).toBe(0)
  })
})

describe("asset selection", () => {
  test("names the CI asset for supported platforms", () => {
    expect(assetNameFor("linux", "x64")).toBe("dient-linux-x64")
    expect(assetNameFor("linux", "arm64")).toBe("dient-linux-arm64")
    expect(assetNameFor("darwin", "arm64")).toBe("dient-darwin-arm64")
    expect(assetNameFor("darwin", "x64")).toBe("dient-darwin-x64")
  })

  test("has no asset for unsupported platforms", () => {
    expect(assetNameFor("win32", "x64")).toBeNull()
    expect(assetNameFor("linux", "ppc")).toBeNull()
    expect(pickAsset(release(), "win32", "x64")).toBeNull()
  })

  test("picks the matching asset from the release", () => {
    expect(pickAsset(release(), "linux", "x64")?.downloadUrl).toBe("https://example.com/dient-linux-x64")
    expect(pickAsset(release({ assets: [] }), "linux", "x64")).toBeNull()
  })

  test("strips the tag prefix", () => {
    expect(normalizeVersion("v0.2.0")).toBe("0.2.0")
  })
})

describe("parseRelease", () => {
  test("parses a stable release payload", () => {
    const parsed = parseRelease({
      tag_name: "v0.2.0",
      body: "notes",
      html_url: "https://example.com/r",
      assets: [{ name: "dient-linux-x64", browser_download_url: "https://example.com/b" }],
    })
    expect(Option.isSome(parsed)).toBe(true)
    if (Option.isSome(parsed)) {
      expect(parsed.value.version).toBe("0.2.0")
      expect(parsed.value.assets).toHaveLength(1)
    }
  })

  test("drops drafts, prereleases, and tagless payloads", () => {
    expect(Option.isNone(parseRelease({ tag_name: "v0.2.0", draft: true }))).toBe(true)
    expect(Option.isNone(parseRelease({ tag_name: "v0.2.0", prerelease: true }))).toBe(true)
    expect(Option.isNone(parseRelease({}))).toBe(true)
  })

  test("skips assets without a download url", () => {
    const parsed = parseRelease({ tag_name: "v0.2.0", assets: [{ name: "dient-linux-x64" }] })
    if (Option.isSome(parsed)) expect(parsed.value.assets).toHaveLength(0)
    else throw new Error("expected a release")
  })
})

describe("update store", () => {
  test("a missing file reads as empty", async () => {
    const store = await run(readStore(join(tmpdir(), "dient-update-missing", `${Date.now()}.json`)))
    expect(store).toEqual({})
  })

  test("round-trips the ignored version and check time", async () => {
    const program = Effect.gen(function* () {
      const path = join(mkdtempSync(join(tmpdir(), "dient-update-")), "update.json")
      yield* writeStore({ ignoredVersion: "0.2.0", lastCheckAt: new Date(0).toISOString() }, path)
      return yield* readStore(path)
    })
    expect(await run(program)).toEqual({ ignoredVersion: "0.2.0", lastCheckAt: new Date(0).toISOString() })
  })

  test("a corrupt file reads as empty", async () => {
    const program = Effect.gen(function* () {
      const path = join(mkdtempSync(join(tmpdir(), "dient-update-")), "update.json")
      yield* Effect.tryPromise(() => writeFile(path, "{nope", "utf8"))
      return yield* readStore(path)
    })
    expect(await run(program)).toEqual({})
  })

  test("throttles recent checks", () => {
    const now = Date.now()
    expect(recentlyChecked({}, 1000, now)).toBe(false)
    expect(recentlyChecked({ lastCheckAt: new Date(now - 500).toISOString() }, 1000, now)).toBe(true)
    expect(recentlyChecked({ lastCheckAt: new Date(now - 2000).toISOString() }, 1000, now)).toBe(false)
    expect(recentlyChecked({ lastCheckAt: "garbage" }, 1000, now)).toBe(false)
  })
})

describe("installer guards", () => {
  test("refuses dev sessions", () => {
    expect(isReleaseBuild("/tmp/bun-fake-binary")).toBe(false)
    expect(isReleaseBuild("/usr/local/bin/bun")).toBe(false)
    expect(isReleaseBuild("/home/xono/.local/bin/dient")).toBe(true)
  })

  test("refuses to install over the bun runtime", async () => {
    const program = installRelease(release(), {
      execPath: "/tmp/bun-fake-binary",
      platform: "linux",
      arch: "x64",
      fetchFn: stubFetch({}),
    })
    await expect(run(program)).rejects.toThrow("dev session")
  })

  test("reports manual download when the platform has no asset", async () => {
    const outcome = await run(
      installRelease(release(), {
        execPath: "/tmp/fake-dient-binary",
        platform: "win32",
        arch: "x64",
        fetchFn: stubFetch({}) as unknown as typeof fetch,
      })
    )
    expect(outcome._tag).toBe("NeedsManual")
  })

  test("installs bytes over a fake binary and marks it executable", async () => {
    const program = Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "dient-install-"))
      const target = join(dir, "dient")
      yield* Effect.tryPromise(() => writeFile(target, "OLD", "utf8"))
      const outcome = yield* installRelease(release(), {
        execPath: target,
        platform: "linux",
        arch: "x64",
        fetchFn: stubFetch({}) as unknown as typeof fetch,
      })
      expect(outcome).toEqual({ _tag: "Installed", version: "0.2.0" })
      const content = yield* Effect.tryPromise(() => readFile(target, "utf8"))
      const mode = (yield* Effect.tryPromise(() => stat(target))).mode
      return { content, executable: (mode & 0o111) !== 0 }
    })
    expect(await run(program)).toEqual({ content: "BINARY", executable: true })
  })
})

describe("checker service", () => {
  test("reports the pending update above the bundled version", async () => {
    const program = Effect.gen(function* () {
      const checker = yield* UpdateChecker
      return yield* checker.check
    }).pipe(Effect.provide(UpdateChecker.layer(testDeps({ fetchFn: stubFetch({ tag_name: "v9.9.9", assets: [] }) }))))
    expect(Option.isSome(await run(program))).toBe(true)
  })

  test("stays silent on the current version and on fetch failure", async () => {
    const current = Effect.gen(function* () {
      const checker = yield* UpdateChecker
      return yield* checker.check
    }).pipe(Effect.provide(UpdateChecker.layer(testDeps())))
    expect(Option.isNone(await run(current))).toBe(true)

    const failing = Effect.gen(function* () {
      const checker = yield* UpdateChecker
      return yield* checker.checkLatest
    }).pipe(
      Effect.provide(
        UpdateChecker.layer(
          testDeps({ fetchFn: (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch })
        )
      )
    )
    /* checkLatest surfaces fetch failure as UpdateError, not silence */
    await expect(run(failing)).rejects.toThrow()
  })

  test("honours the ignore list", async () => {
    const program = Effect.gen(function* () {
      const checker = yield* UpdateChecker
      const first = yield* checker.check
      expect(Option.isSome(first)).toBe(true)
      yield* checker.ignore("9.9.9")
      return yield* checker.checkLatest
    }).pipe(Effect.provide(UpdateChecker.layer(testDeps({ fetchFn: stubFetch({ tag_name: "v9.9.9", assets: [] }) }))))
    expect(Option.isNone(await run(program))).toBe(true)
  })
})
