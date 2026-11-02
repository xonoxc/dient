/**
 * Shared Either helpers for JSON parsing, stringifying, and deep cloning.
 *
 * Centralising these keeps the error handling consistent (every operation
 * returns an `Either` instead of throwing) and removes the scattered
 * `Either.try(() => JSON.parse(...))` boilerplate across the codebase.
 */
import { Either } from "effect"

/** Parse a JSON string. Returns `Left` with the underlying error on failure. */
export const parseJson = <T = unknown>(text: string): Either.Either<T, unknown> =>
  Either.try(() => JSON.parse(text) as T)

/** Stringify a value. Returns `Left` with the underlying error on failure
 *  (e.g. circular references, BigInt). */
export const stringifyJson = (
  value: unknown,
  space?: number
): Either.Either<string, unknown> =>
  Either.try(() => {
    const out = JSON.stringify(value, null, space)
    return out === undefined ? "null" : out
  })

/** Deep-clone a value via `structuredClone`. Returns `Left` on failure. */
export const deepClone = <T>(value: T): Either.Either<T, unknown> =>
  Either.try(() => structuredClone(value))

/** Pretty-print a JSON string: parse then re-stringify with indentation.
 *  Falls back to the original text when parsing fails. */
export const prettyJson = (text: string, space = 2): string =>
  Either.match(parseJson(text), {
    onLeft: () => text,
    onRight: parsed =>
      Either.getOrElse(stringifyJson(parsed, space), () => text),
  })

/** Alias matching the requested `safe*` naming. */
export const safeParseJSON = parseJson
export const safeStringifyJSON = stringifyJson
export const safeDeepClone = deepClone
export const safePrettyJSON = prettyJson
