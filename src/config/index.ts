/**
 * Public surface of the config package. Tests and the TUI only ever import
 * `@/config`, never the individual modules, so the internal layout (store vs.
 * migrations) can change without touching callers.
 */
export { ConfigStore, ConfigError } from "@/config/config-store"
export type {
  ConfigStoreService,
  CreateDatabaseInput,
  UpdateDatabaseInput,
  CreateConnectionInput,
  UpdateConnectionInput,
} from "@/config/config-store"
