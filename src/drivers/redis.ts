/**
 * Redis driver. Redis is deliberately not a `DatabaseDriver`: it has no SQL,
 * tables, or result-set metadata. This low-level service owns the client
 * lifecycle and sends raw commands; `RedisInspector` turns those commands into
 * typed pages for the explorer.
 *
 * The app already targets Bun, so this uses Bun's built-in Redis client rather
 * than adding a Node client dependency. Cluster/sentinel support is not part of
 * this driver.
 */
import { Context, Effect, Exit, Layer, Scope } from "effect"
import type { RedisConnectionConfig } from "@/domain"
import type { ActiveConnection } from "@/drivers/types"
import { ConnectionError, QueryError } from "@/drivers/types"
import { describeError } from "@/errors/describe"

const ENGINE = "redis" as const

export interface RedisDriverService {
  readonly connect: (config: RedisConnectionConfig) => Effect.Effect<ActiveConnection, ConnectionError, Scope.Scope>
  readonly command: (
    conn: ActiveConnection,
    command: string,
    args?: ReadonlyArray<string | number>
  ) => Effect.Effect<unknown, QueryError>
  readonly disconnect: (conn: ActiveConnection) => Effect.Effect<void>
  readonly isConnected: (conn: ActiveConnection) => Effect.Effect<boolean>
}

export class RedisDriver extends Context.Tag("RedisDriver")<RedisDriver, RedisDriverService>() {}

const redisUrl = (config: RedisConnectionConfig): string => {
  const host = config.host?.trim() || "localhost"
  const hostPart = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
  const port = config.port ?? 6379
  const db = config.defaultDatabase?.trim() || "0"
  const scheme = config.tls ? "rediss" : "redis"
  const user = config.user?.trim()
  const password = config.password
  const auth =
    user && password !== undefined
      ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`
      : user
        ? `${encodeURIComponent(user)}@`
        : password !== undefined
          ? `:${encodeURIComponent(password)}@`
          : ""
  return `${scheme}://${auth}${hostPart}:${port}/${db}`
}

const clientOf = (conn: ActiveConnection): Bun.RedisClient => conn._client as Bun.RedisClient

const asQueryError = (cause: unknown): QueryError =>
  new QueryError({ engine: ENGINE, message: describeError(cause), cause })

export const connectRedis = (
  config: RedisConnectionConfig
): Effect.Effect<ActiveConnection, ConnectionError, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const client = yield* Effect.try({
      try: () =>
        new Bun.RedisClient(redisUrl(config), {
          connectionTimeout: 5000,
          maxRetries: 3,
          ...(config.tls ? { tls: true } : {}),
        }),
      catch: cause =>
        new ConnectionError({
          engine: ENGINE,
          message: describeError(cause),
          cause,
        }),
    })

    /* The scope is the single owner of the socket. It is closed exactly once by
       `disconnect` or by the surrounding scope. */
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => client.close())
    )

    const handshake = Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => client.connect(),
        catch: cause =>
          new ConnectionError({
            engine: ENGINE,
            message: describeError(cause),
            cause,
          }),
      })

      const pong = yield* Effect.tryPromise({
        try: () => client.send("PING", []),
        catch: cause =>
          new ConnectionError({
            engine: ENGINE,
            message: describeError(cause),
            cause,
          }),
      })
      if (pong !== "PONG") {
        return yield* Effect.fail(
          new ConnectionError({ engine: ENGINE, message: `unexpected Redis PING response: ${String(pong)}` })
        )
      }
    })

    /* A failed or interrupted handshake must not leave the socket (or its
       finalizer scope) behind; a successful one hands the open scope to the
       cached ActiveConnection for `disconnectRedis` to close later. */
    yield* handshake.pipe(
      Effect.onExit(exit =>
        Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, Exit.void).pipe(Effect.exit, Effect.asVoid)
      )
    )

    return { id: crypto.randomUUID(), engine: ENGINE, _client: client, _scope: scope }
  })

export const commandRedis = (
  conn: ActiveConnection,
  command: string,
  args: ReadonlyArray<string | number> = []
): Effect.Effect<unknown, QueryError> =>
  Effect.tryPromise({
    try: () => clientOf(conn).send(command, args.map(String)),
    catch: asQueryError,
  })

export const disconnectRedis = (conn: ActiveConnection): Effect.Effect<void> =>
  Scope.close(conn._scope as Scope.CloseableScope, Exit.void)

export const isConnectedRedis = (conn: ActiveConnection): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const client = clientOf(conn)
    if (!client.connected) return false
    const pong = yield* commandRedis(conn, "PING").pipe(Effect.orElseSucceed(() => null))
    return pong === "PONG"
  })

export namespace RedisDriver {
  export const layer: Layer.Layer<RedisDriver> = Layer.succeed(RedisDriver, {
    connect: connectRedis,
    command: commandRedis,
    disconnect: disconnectRedis,
    isConnected: isConnectedRedis,
  })
}
