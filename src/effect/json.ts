/**
 * Shared Result helpers for JSON parsing, stringifying, and deep cloning.
 *
 * Centralising these keeps the error handling consistent (every operation
 * returns a `Result` instead of throwing) and removes the scattered
 * `Result.try(() => JSON.parse(...))` boilerplate across the codebase.
 */
import { Result } from "effect"

export const parseJson = <T = unknown>(text: string): Result.Result<T, unknown> =>
  Result.try(() => JSON.parse(text) as T)

export const stringifyJson = (value: unknown, space?: number): Result.Result<string, unknown> =>
  Result.try(() => {
    const out = JSON.stringify(value, null, space)
    return out === undefined ? "null" : out
  })

export const deepClone = <T>(value: T): Result.Result<T, unknown> => Result.try(() => structuredClone(value))

/** Pretty-print a JSON string: parse then re-stringify with indentation.
 *  Falls back to the original text when parsing fails. */
export const prettyJson = (text: string, space = 2): string =>
  Result.match(parseJson(text), {
    onFailure: () => text,
    onSuccess: parsed => Result.getOrElse(stringifyJson(parsed, space), () => text),
  })

/** Alias matching the requested `safe*` naming. */
export const safeParseJSON = parseJson
export const safeStringifyJSON = stringifyJson
export const safeDeepClone = deepClone
export const safePrettyJSON = prettyJson
