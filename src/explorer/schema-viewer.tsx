/**
 * Schema viewer — the structured `D` overlay.
 *
 * Instead of dumping a plain-text document, the schema renders as aligned,
 * color-coded sections: a column grid (name / type / null / key / default),
 * then primary key, indexes, foreign keys, and the DDL last. The explorer
 * owns the keyboard and the scroll offset exactly like `TextViewer`; this
 * module builds and paints the rows.
 */
import { useTheme } from "@/theme-context"
import { ModalSurface } from "@/ui/modal-surface"
import { wrapText } from "@/explorer/cell-viewer"
import type { TableInfo } from "@/inspector/types"

type Tone = "bright" | "normal" | "muted" | "accent"

export interface SchemaCell {
  readonly text: string
  readonly tone: Tone
  /** Fixed cell width; shorter cells pad, longer ones truncate. */
  readonly width?: number
}

export type SchemaRow =
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "cells"; readonly cells: ReadonlyArray<SchemaCell> }
  | { readonly kind: "text"; readonly tone: Tone; readonly text: string }
  | { readonly kind: "blank" }

const INDENT = "  "

const cell = (text: string, tone: Tone, width?: number): SchemaCell => ({ text, tone, width })

/** Column-grid widths: roomy enough to scan, capped so a pathological column
 *  name cannot push the type/null cells off screen. */
const gridWidth = (lengths: ReadonlyArray<number>, min: number, max: number): number =>
  Math.min(max, Math.max(min, ...lengths.map(length => length + 2), min))

/** Build the scrollable rows for one table. `textWidth` is the wrapped text
 *  room inside the modal; DDL paragraphs wrap to it, grid cells truncate. */
export const schemaRows = (info: TableInfo, textWidth: number): ReadonlyArray<SchemaRow> => {
  const rows: SchemaRow[] = []
  const pushHeading = (text: string): void => {
    rows.push({ kind: "blank" })
    rows.push({ kind: "heading", text })
  }
  const pushWrapped = (text: string, tone: Tone): void => {
    for (const line of wrapText(text, Math.max(16, textWidth - INDENT.length))) {
      rows.push({ kind: "text", tone, text: `${INDENT}${line}` })
    }
  }
  const pushNone = (): void => {
    rows.push({ kind: "text", tone: "muted", text: `${INDENT}(none)` })
  }

  const nameWidth = gridWidth(
    info.columns.map(column => column.name.length),
    10,
    26
  )
  const typeWidth = gridWidth(
    info.columns.map(column => column.type.length),
    8,
    18
  )
  const indexNameWidth = gridWidth(
    info.indexes.map(index => index.name.length),
    10,
    26
  )

  rows.push({ kind: "heading", text: "COLUMNS" })
  rows.push({
    kind: "cells",
    cells: [
      cell(`${INDENT}NAME`, "muted", nameWidth + INDENT.length),
      cell("TYPE", "muted", typeWidth),
      cell("NULL", "muted", 9),
      cell("KEY", "muted", 5),
      cell("DEFAULT", "muted"),
    ],
  })
  for (const column of info.columns) {
    rows.push({
      kind: "cells",
      cells: [
        cell(`${INDENT}${column.name}`, "bright", nameWidth + INDENT.length),
        cell(column.type, "normal", typeWidth),
        cell(column.nullable ? "null" : "not null", "muted", 9),
        cell(info.primaryKey.includes(column.name) ? "pk" : "", "accent", 5),
        cell(column.default === undefined ? "" : `default ${String(column.default)}`, "muted"),
      ],
    })
  }

  pushHeading("PRIMARY KEY")
  if (info.primaryKey.length > 0) {
    rows.push({ kind: "text", tone: "bright", text: `${INDENT}${info.primaryKey.join(", ")}` })
  } else {
    pushNone()
  }

  pushHeading("INDEXES")
  if (info.indexes.length === 0) {
    pushNone()
  } else {
    for (const index of info.indexes) {
      const flags = [index.unique ? "unique" : "non-unique", index.primary ? "primary" : ""]
        .filter(part => part.length > 0)
        .join(" · ")
      rows.push({
        kind: "cells",
        cells: [
          cell(`${INDENT}${index.name}`, "bright", indexNameWidth + INDENT.length),
          cell(`(${index.columns.join(", ")})`, "normal"),
          cell(flags, "muted"),
        ],
      })
    }
  }

  pushHeading("FOREIGN KEYS")
  if (info.foreignKeys.length === 0) {
    pushNone()
  } else {
    for (const foreignKey of info.foreignKeys) {
      rows.push({
        kind: "cells",
        cells: [
          cell(`${INDENT}${foreignKey.name}`, "bright"),
          cell(
            `(${foreignKey.columns.join(", ")}) -> ${foreignKey.referencedTable} (${foreignKey.referencedColumns.join(", ")})`,
            "normal"
          ),
        ],
      })
    }
  }

  if (info.ddl) {
    pushHeading("DDL")
    pushWrapped(info.ddl, "muted")
  }

  return rows
}

/** Total row count, for the explorer's scroll clamping. */
export const schemaViewerRowCount = (info: TableInfo, textWidth: number): number => schemaRows(info, textWidth).length

export interface SchemaViewerProps {
  readonly info: TableInfo
  readonly visibleRows: number
  readonly offset: number
  /** Outer modal width; callers use `textViewerWidth` so scrolling matches. */
  readonly width: number
}

const TONE_COLOR: Record<Tone, "textBright" | "text" | "textMuted" | "accent"> = {
  bright: "textBright",
  normal: "text",
  muted: "textMuted",
  accent: "accent",
}

export function SchemaViewer({ info, visibleRows, offset, width }: SchemaViewerProps) {
  const theme = useTheme()
  const c = theme.colors
  const rows = schemaRows(info, Math.max(32, width - 4))
  const room = Math.max(1, visibleRows)
  const top = Math.max(0, Math.min(offset, Math.max(0, rows.length - room)))
  const shown = rows.slice(top, top + room)
  const scrollable = rows.length > room

  return (
    <box position="absolute" top={0} bottom={0} left={0} right={0} alignItems="center" justifyContent="center">
      <box position="absolute" top={0} bottom={0} left={0} right={0} backgroundColor={c.bgScrim} />
      <ModalSurface width={width} paddingY={1} elevated maxHeight={Math.max(8, room + 6)}>
        <box height={1} flexDirection="row">
          <text fg={c.accent}>{`schema · ${info.name}`}</text>
          <box flexGrow={1} />
          {scrollable ? (
            <text fg={c.textMuted}>{`rows ${top + 1}–${top + shown.length} of ${rows.length}`}</text>
          ) : null}
        </box>
        <box height={1} />
        {shown.map((row, index) => {
          const key = top + index
          if (row.kind === "blank") return <box key={key} height={1} />
          if (row.kind === "heading") {
            return (
              <box key={key} height={1} flexDirection="row">
                <text fg={c.accent}>{row.text}</text>
              </box>
            )
          }
          if (row.kind === "text") {
            return (
              <box key={key} height={1} flexDirection="row">
                <text fg={c[TONE_COLOR[row.tone]]} truncate>
                  {row.text.length > 0 ? row.text : " "}
                </text>
              </box>
            )
          }
          return (
            <box key={key} height={1} flexDirection="row">
              {row.cells.map((schemaCell, cellIndex) => (
                <text
                  key={cellIndex}
                  fg={c[TONE_COLOR[schemaCell.tone]]}
                  width={schemaCell.width}
                  truncate={schemaCell.width !== undefined}
                >
                  {schemaCell.text}
                </text>
              ))}
            </box>
          )
        })}
        <box height={1} />
        <text fg={c.textMuted}>{` j/k scroll · g/G ends · D/Esc close `}</text>
      </ModalSurface>
    </box>
  )
}
