/**
 * Bootstraps every Effect service the TUI needs and hands screens plain
 * service interfaces, keeping React free of Effect plumbing.
 *
 * `buildAppLayer` wires cross-layer dependencies explicitly (`Layer.provide`)
 * so the assembled graph needs nothing from outside. Resources (SQLite client,
 * driver pools) attach to whatever scope builds it, so callers build this
 * inside a scope that lives for the whole app (see `src/index.tsx`).
 */
import { ConfigStore } from "@/config"
import { DatabaseDriver } from "@/drivers/database-driver"
import { RedisDriver } from "@/drivers/redis"
import { SchemaInspector } from "@/inspector"
import { ConnectionManager } from "@/connection/connection-manager"
import { QueryExecutor } from "@/query/query-executor"
import { RedisInspector } from "@/redis/redis-inspector"
import { RabbitMqDriver } from "@/rabbitmq/driver"
import { UpdateChecker, type UpdateCheckerDeps } from "@/update/update-checker"
import { defaultLogPath, makeErrorLog } from "@/log/error-log"
import type { AppServices } from "@/app-context"
import { Context, Effect, Layer, type Scope } from "effect"

export const buildAppLayer = (configPath?: string, updateDeps?: UpdateCheckerDeps) => {
  const updateLayer = updateDeps ? UpdateChecker.layer(updateDeps) : UpdateChecker.layerDefault
  const base = Layer.mergeAll(
    ConfigStore.layer(configPath),
    DatabaseDriver.layer,
    RedisDriver.layer,
    RabbitMqDriver.layer,
    updateLayer
  )
  return Layer.mergeAll(
    base,
    Layer.provide(ConnectionManager.layer, base),
    Layer.provide(SchemaInspector.layer, base),
    Layer.provide(RedisInspector.layer, base),
    Layer.provide(QueryExecutor.layer, Layer.mergeAll(base, Layer.provide(ConnectionManager.layer, base)))
  )
}

export const resolveAppServices = (configPath?: string): Effect.Effect<AppServices, never, Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(buildAppLayer(configPath))
    return {
      configStore: Context.get(context, ConfigStore),
      schemaInspector: Context.get(context, SchemaInspector),
      redisInspector: Context.get(context, RedisInspector),
      rabbitmqDriver: Context.get(context, RabbitMqDriver),
      connectionManager: Context.get(context, ConnectionManager),
      queryExecutor: Context.get(context, QueryExecutor),
      updateChecker: Context.get(context, UpdateChecker),
      errorLog: makeErrorLog(defaultLogPath()),
    }
  })
