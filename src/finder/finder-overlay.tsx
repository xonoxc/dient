/**
 * Telescope-style finder overlay. Filters the finder index live as you type,
 * pans with the arrow keys, and jumps on Enter. The overlay is rendered as an
 * absolute strip near the top of the explorer; the explorer owns the keyboard
 * and state, this is the pure view.
 */
import { useTerminalDimensions } from "@opentui/react"
import { useTheme } from "@/theme-context"
import type { ThemeColors } from "@/theme"
import { fuzzyMatch, splitByPositions, type FuzzyMatch } from "@/finder/fuzzy"
import type { FinderEntry, FinderKind } from "@/finder/finder"
import { LoadingIndicator } from "@/ui/loading-indicator"
import { ModalSurface } from "@/ui/modal-surface"

export interface FinderOverlayProps {
  readonly query: string
  readonly entries: ReadonlyArray<FinderEntry>
  readonly cursor: number
  readonly loading?: boolean
}

const KIND_TAG: Record<FinderKind, string> = { table: "tbl", db: "db ", project: "prj" }

const kindColor = (kind: FinderKind, c: ThemeColors) =>
  kind === "table" ? c.info : kind === "db" ? c.warning : c.accentMuted

export function FinderOverlay({ query, entries, cursor, loading = false }: FinderOverlayProps) {
  const theme = useTheme()
  const { width } = useTerminalDimensions()
  const c = theme.colors
  const panelWidth = Math.max(32, Math.min(70, width - 4))

  return (
    <box position="absolute" width="100%" alignItems="center" flexDirection="column">
      <ModalSurface width={panelWidth} paddingY={1} marginTop={1}>
        <box height={1} flexDirection="row" alignItems="center">
          <text fg={c.accent}>&gt; </text>
          <text fg={c.textBright}>{query}</text>
          <text fg={c.accent}>▍</text>
          <box flexGrow={1} />
          <text fg={c.textMuted}>{loading ? "indexing…" : `${entries.length} matches`}</text>
        </box>
        <box height={1} />
        {loading ? (
          <box height={1}>
            <LoadingIndicator label="searching your connections…" />
          </box>
        ) : entries.length === 0 ? (
          <box height={1}>
            <text fg={c.textMuted}>no matches for "{query}"</text>
          </box>
        ) : (
          entries.map((entry, index) => (
            <FinderRow key={entry.id} entry={entry} selected={index === cursor} query={query} />
          ))
        )}
        <text fg={c.textMuted}> type to filter · ↑/↓ move · Enter jump · Esc close </text>
      </ModalSurface>
    </box>
  )
}

function FinderRow({ entry, selected, query }: { entry: FinderEntry; selected: boolean; query: string }) {
  const theme = useTheme()
  const c = theme.colors
  const match = fuzzyMatch(query, entry.label) as FuzzyMatch | null
  const parts = match && match.positions.length > 0 ? splitByPositions(entry.label, match.positions) : null

  return (
    <box height={1} flexDirection="row" backgroundColor={selected ? c.bgHighlight : undefined}>
      <text fg={selected ? c.accent : c.textMuted} width={1}>
        {selected ? "▶" : " "}
      </text>
      <text fg={kindColor(entry.kind, c)} width={5}>
        {KIND_TAG[entry.kind]}
      </text>
      {parts ? (
        <box flexDirection="row">
          {parts.map((part, index) => (
            <text key={index} fg={part.matched ? c.accent : selected ? c.textBright : c.text}>
              {part.text}
            </text>
          ))}
        </box>
      ) : (
        <text fg={selected ? c.textBright : c.text}>{entry.label}</text>
      )}
      {entry.sub ? <text fg={c.textMuted}> · {entry.sub}</text> : null}
    </box>
  )
}
