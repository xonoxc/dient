/**
 * Public surface of the drivers module. Components import from `@/drivers`
 * (the facade + shared types); the per-engine modules stay importable for
 * tests that want to assert on a specific engine without the facade.
 */
export { DatabaseDriver } from "@/drivers/database-driver"
export { connectMysql, disconnectMysql, isConnectedMysql, MysqlDriver, queryMysql } from "@/drivers/mysql"
export { connectPg, disconnectPg, isConnectedPg, PgDriver, queryPg } from "@/drivers/pg"
export {
  commandRedis,
  connectRedis,
  disconnectRedis,
  isConnectedRedis,
  RedisDriver,
  type RedisDriverService,
} from "@/drivers/redis"
export { connectSqlite, disconnectSqlite, isConnectedSqlite, querySqlite, SqliteDriver } from "@/drivers/sqlite"
export {
  bindRabbitQueue,
  connectRabbitMq,
  declareRabbitExchange,
  declareRabbitQueue,
  deleteRabbitExchange,
  deleteRabbitQueue,
  disconnectRabbitMq,
  isConnectedRabbitMq,
  listRabbitBindings,
  listRabbitExchanges,
  listRabbitQueues,
  peekRabbitMessages,
  publishRabbitMessage,
  purgeRabbitQueue,
  RabbitMqDriver,
  unbindRabbitQueue,
  type RabbitBinding,
  type RabbitExchange,
  type RabbitMessage,
  type RabbitMqDriverService,
  type RabbitQueue,
} from "@/rabbitmq/driver"
export type { ActiveConnection, ColumnInfo, DriverService, QueryResult } from "@/drivers/types"
export { ConnectionError, QueryError } from "@/drivers/types"
