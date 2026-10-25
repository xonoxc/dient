/**
 * Identifier/query helpers shared by the query layer. Table and column names
 * coming from the schema inspector are quoted with the engine's own rules so a
 * user table like `order items` or `select` stays addressable, while anything
 * that is not a plain name is rejected at the start (no identifier injection).
 */
import type { Engine } from "@/domain"
import { Data, Effect } from "effect"

export class IdentifierError extends Data.TaggedError("IdentifierError")<{
  /** The rejected name, for the message the caller builds. */
  readonly name: string
}> {}

/* Only well-formed names are accepted for quoting; anything else fails. */
export const isSafeName = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)

export const cleanIdentifier = (engine: Engine, name: string): Effect.Effect<string, IdentifierError> => {
  if (!isSafeName(name)) return Effect.fail(new IdentifierError({ name }))

  switch (engine) {
    case "mysql":
      return Effect.succeed("`" + name + "`")
    default:
      return Effect.succeed('"' + name + '"')
  }
}

export const limitClause = (limit: number, offset: number): string =>
  `LIMIT ${Math.max(0, limit)} OFFSET ${Math.max(0, offset)}`
