/**
 * Filesystem path completion for the sqlite filename form field. `pathCandidates`
 * returns the entries that extend the typed prefix (directories get a trailing
 * `/`), and `completePath` snaps the draft to the longest common prefix of those
 * matches — the classic shell Tab behavior, minus the interactive picker.
 *
 * Both are pure over a small fs surface so they unit-test with throwaway dirs
 * and degrade to a no-op whenever the path is unreadable.
 */
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

const MAX_CANDIDATES = 12

const isDirectory = (path: string): boolean => {
  try {
    return existsSync(path) && readdirSync(path) !== undefined
  } catch {
    return false
  }
}

/** Split a draft into its parent directory and the trailing name prefix. */
const splitDraft = (draft: string): { dir: string; prefix: string } => {
  const lastSlash = draft.lastIndexOf("/")
  if (lastSlash >= 0) {
    return { dir: draft.slice(0, lastSlash + 1), prefix: draft.slice(lastSlash + 1) }
  }
  return { dir: "", prefix: draft }
}

const absoluteDirOf = (dir: string): string =>
  dir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dir) ? dir : join(process.cwd(), dir)

/** Entries under `dirPath` that start with `prefix`, normalized for display. */
export const pathCandidates = (draft: string): ReadonlyArray<string> => {
  const { dir, prefix } = splitDraft(draft)
  const absoluteDir = absoluteDirOf(dir)
  if (!existsSync(absoluteDir) || !isDirectory(absoluteDir)) return []
  let entries: ReadonlyArray<string>
  try {
    entries = readdirSync(absoluteDir)
  } catch {
    return []
  }
  return entries
    .filter(name => name.startsWith(prefix))
    .slice(0, MAX_CANDIDATES)
    .map(name => `${dir}${name}${isDirectory(join(absoluteDir, name)) ? "/" : ""}`)
}

/** Longest common prefix of a non-empty candidate list. */
const commonPrefix = (candidates: ReadonlyArray<string>): string => {
  if (candidates.length === 0) return ""
  let common = candidates[0]!
  for (const candidate of candidates.slice(1)) {
    let i = 0
    while (i < common.length && i < candidate.length && common[i] === candidate[i]) i++
    common = common.slice(0, i)
    if (common === "") break
  }
  return common
}

/** Extend `draft` to the longest common prefix of its filesystem matches. */
export const completePath = (draft: string): string => {
  const prefix = commonPrefix(pathCandidates(draft))
  return prefix.length > draft.length ? prefix : draft
}
