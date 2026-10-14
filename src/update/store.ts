/**
 * Persistent update state: which version the user ignored, and when the last
 * check ran (checks are throttled so restarts do not hammer the API).
 *
 * A JSON sidecar next to the config database (`~/.dient/update.json`), not a
 * config table — update state is machine-local bookkeeping, not user data, so
 * it skips migrations and the service layer. A missing or corrupt file reads
 * as empty: a broken sidecar must never fail a session, so reads carry no
 * error channel at all.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { Effect } from "effect"
import { UpdateError } from "@/update/errors"

export interface UpdateStore {
  readonly ignoredVersion?: string
  /** ISO timestamp of the last check, whatever triggered it. */
  readonly lastCheckAt?: string
}

export const defaultStorePath = (): string => join(homedir(), ".dient", "update.json")

/** Plain parser: unknown fields are dropped, garbage parses as empty. */
const parseStore = (raw: string): UpdateStore => {
  try {
    const parsed = JSON.parse(raw) as Partial<UpdateStore>
    return {
      ...(typeof parsed.ignoredVersion === "string" ? { ignoredVersion: parsed.ignoredVersion } : {}),
      ...(typeof parsed.lastCheckAt === "string" ? { lastCheckAt: parsed.lastCheckAt } : {}),
    }
  } catch {
    return {}
  }
}

export const readStore = (path: string = defaultStorePath()): Effect.Effect<UpdateStore> =>
  Effect.tryPromise(() => readFile(path, "utf8")).pipe(
    Effect.map(parseStore),
    Effect.orElseSucceed(() => ({}))
  )

export const writeStore = (store: UpdateStore, path: string = defaultStorePath()): Effect.Effect<void, UpdateError> =>
  Effect.tryPromise({
    try: () =>
      mkdir(dirname(path), { recursive: true }).then(() => writeFile(path, `${JSON.stringify(store)}\n`, "utf8")),
    catch: cause => new UpdateError({ message: "could not write update store", cause }),
  })

/** True when the last check is recent enough to skip. Pure: time is an argument. */
export const recentlyChecked = (store: UpdateStore, maxAgeMs: number, now: number = Date.now()): boolean => {
  if (!store.lastCheckAt) return false
  const at = Date.parse(store.lastCheckAt)
  if (Number.isNaN(at)) return false
  return now - at < maxAgeMs
}
