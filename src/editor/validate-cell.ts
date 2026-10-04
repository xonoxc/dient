/**
 * Column-type validation for a value on its way into an UPDATE.
 *
 * Shared by the write path so a draft is checked against the same rules whether
 * it arrived from the `$EDITOR` file or from anywhere else: an integer column
 * that takes `abc` fails here rather than at the driver, where the error would
 * name the driver instead of the column.
 */
import type { ColumnInfo } from "@/drivers/types"

const NUMERIC = /^-?\d+(\.\d+)?$/

export const validateCellValue = (column: ColumnInfo, value: string): string | null => {
  const type = (column.type ?? "").toLowerCase()
  if (!type) return null
  if (value === "") return null

  if (/int|bigint|smallint|numeric|decimal|real|float|double|serial|money|double_precision/.test(type)) {
    if (!NUMERIC.test(value)) return `"${column.name}" expects a number`
  }
  if (/bool/.test(type)) {
    if (!/^(true|false|0|1)$/i.test(value)) return `"${column.name}" expects true/false`
  }
  return null
}
