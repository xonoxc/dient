/**
 * The update domain's single error type, mirroring `ConfigError`: callers
 * match on one type instead of the many that fetch and the filesystem throw.
 * Expected alternative outcomes (no update, manual download needed) are
 * values (`Option`, unions), never errors — failing means something actually
 * went wrong.
 */
import { Data } from "effect"

export class UpdateError extends Data.TaggedError("UpdateError")<{
  readonly message: string
  readonly cause?: unknown
}> {}
