/**
 * The one place a service effect becomes a promise.
 */
import { Effect, Either } from "effect"

/**
 * Run a service effect as a promise, rejecting with the effect's *typed* error.
 *
 * `Effect.runPromise` rejects with a `FiberFailure` instead, and a `FiberFailure`
 * is a rendering artefact: it carries only `name` and `stack`, with no `cause`
 * to walk. The driver's own `ConnectionError` — and through it the
 * `connect ECONNREFUSED …` underneath — is simply not reachable from it, so a
 * caller can only report a dump or a bare "Failed to connect".
 *
 * Converting to `Either` first rejects with the error the effect actually
 * failed with. Use this everywhere a service effect is awaited inside a `.catch`
 * that shows a message to someone.
 */
export const runService = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.either(effect)).then(result =>
    Either.isLeft(result) ? Promise.reject(result.left) : Promise.resolve(result.right)
  )
