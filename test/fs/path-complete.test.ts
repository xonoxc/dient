/**
 * Path completion unit tests — `pathCandidates` and `completePath` run against
 * throwaway directories so the behavior (prefix match, trailing `/` for
 * directories, longest-common-prefix completion, no-op fallbacks) is pinned
 * without touching the TUI.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { completePath, pathCandidates } from "@/fs/path-complete"

const TMP = mkdtempSync(join(tmpdir(), "dient-path-"))
writeFileSync(join(TMP, "users.db"), "")
writeFileSync(join(TMP, "orders.db"), "")
mkdirSync(join(TMP, "sandbox"))

describe("pathCandidates", () => {
  test("an empty draft lists working-directory entries, capped at 12", () => {
    const matches = pathCandidates("")
    expect(matches.length).toBeGreaterThan(0)
    expect(matches.length).toBeLessThanOrEqual(12)
  })

  test("matches entries by prefix against the absolute directory", () => {
    const matches = pathCandidates(join(TMP, "use"))
    expect(matches.some(match => match.endsWith("users.db"))).toBe(true)
  })

  test("directories get a trailing slash", () => {
    expect(pathCandidates(join(TMP, "sand"))).toEqual([`${TMP}/sandbox/`])
  })

  test("missing or unreadable paths yield no candidates", () => {
    expect(pathCandidates("/definitely/not/here/x")).toEqual([])
  })

  test("returns every prefix match within the cap", () => {
    const dir = mkdtempSync(join(TMP, "case-"))
    writeFileSync(join(dir, "alpha.db"), "")
    writeFileSync(join(dir, "alpine.db"), "")
    writeFileSync(join(dir, "beta.db"), "")
    const matches = pathCandidates(join(dir, "al"))
    expect(matches).toHaveLength(2)
    expect(matches.every(match => match.startsWith(join(dir, "al")))).toBe(true)
  })
})

describe("completePath", () => {
  test("extends a draft to its longest common prefix", () => {
    expect(completePath(join(TMP, "use"))).toBe(`${TMP}/users.db`)
  })

  test("a directory match completes with a trailing slash", () => {
    expect(completePath(join(TMP, "sand"))).toBe(`${TMP}/sandbox/`)
  })

  test("ambiguous matches stop at the common prefix", () => {
    const dir = mkdtempSync(join(TMP, "case-"))
    writeFileSync(join(dir, "alpha.db"), "")
    writeFileSync(join(dir, "alpine.db"), "")
    /* alpha.db and alpine.db share the prefix `…/alp` — nothing beyond it is certain */
    expect(completePath(join(dir, "al"))).toBe(join(dir, "alp"))
  })

  test("no matches leaves the draft untouched", () => {
    expect(completePath(join(TMP, "zzzz"))).toBe(join(TMP, "zzzz"))
  })

  test("cleans up its throwaway directory", () => {
    rmSync(TMP, { recursive: true, force: true })
    expect(pathCandidates(join(TMP, "use"))).toEqual([])
  })
})
