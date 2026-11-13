/**
 * Plain-text schema document for the `D` viewer. Keeping the formatting in the
 * inspector layer (rather than JSX) makes the exact text testable and keeps the
 * overlay a generic scroller.
 */
import type { TableInfo } from "@/inspector/types"

const section = (title: string, lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.length === 0 ? [title, "  (none)"] : [title, ...lines]

export const formatTableInfo = (info: TableInfo): string => {
  const nameWidth = Math.max(4, ...info.columns.map(column => column.name.length))
  const typeWidth = Math.max(4, ...info.columns.map(column => column.type.length))
  const columnLines = info.columns.map(column => {
    const flags = [column.nullable ? "null" : "not null"]
    if (column.default !== undefined) flags.push(`default ${String(column.default)}`)
    return `  ${column.name.padEnd(nameWidth)}  ${column.type.padEnd(typeWidth)}  ${flags.join(" · ")}`
  })

  const indexLines = info.indexes.map(index => {
    const flags = [index.unique ? "unique" : "non-unique"]
    if (index.primary) flags.push("primary")
    return `  ${index.name}  (${index.columns.join(", ")})  ${flags.join(" · ")}`
  })

  const foreignKeyLines = info.foreignKeys.map(
    fk => `  ${fk.name}  (${fk.columns.join(", ")}) -> ${fk.referencedTable} (${fk.referencedColumns.join(", ")})`
  )

  const lines: Array<string> = [`TABLE ${info.name}`, ""]
  if (info.ddl) {
    lines.push(...section("DDL", info.ddl.split("\n")), "")
  }
  lines.push(
    ...section("COLUMNS", columnLines),
    "",
    ...section("PRIMARY KEY", info.primaryKey.length === 0 ? [] : [`  ${info.primaryKey.join(", ")}`]),
    "",
    ...section("INDEXES", indexLines),
    "",
    ...section("FOREIGN KEYS", foreignKeyLines)
  )
  return lines.join("\n")
}
