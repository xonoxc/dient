/**
 * A thin horizontal scroll indicator.
 *
 * OpenTUI's built-in scrollbar is unusable for this job: its slider hard-codes a
 * solid `█` thumb, fills the whole track with a background colour, and always
 * occupies a full row. Painted under the data table it read as a second bar
 * stacked on the status bar, even for a two-column table with nothing to
 * scroll. A terminal cell is indivisible, so no restyling makes that thinner —
 * it has to be replaced.
 *
 * This draws a single rule of `─` instead, and only when the content is
 * genuinely wider than the viewport, so the common case costs no row at all.
 */
import { useEffect, useState } from "react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTheme } from "@/theme-context"

interface Geometry {
  readonly content: number
  readonly viewport: number
  readonly left: number
}

/** Fast enough to look live while panning, cheap enough to ignore. */
const POLL_MS = 80

/**
 * Read the scrollbox's own geometry.
 *
 * OpenTUI's React layer exposes no `onScroll`, so the position is sampled on an
 * interval instead. `setState` is skipped when nothing moved, so an idle table
 * costs one comparison per tick rather than a re-render.
 */
function useScrollGeometry(box: ScrollBoxRenderable | null): Geometry | null {
  const [geometry, setGeometry] = useState<Geometry | null>(null)

  useEffect(() => {
    if (!box) {
      setGeometry(null)
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false

    const read = (): void => {
      if (cancelled) return
      const next: Geometry = { content: box.scrollWidth, viewport: box.width, left: box.scrollLeft }
      setGeometry(previous =>
        previous !== null &&
        previous.content === next.content &&
        previous.viewport === next.viewport &&
        previous.left === next.left
          ? previous
          : next
      )
      timer = setTimeout(read, POLL_MS)
    }
    read()

    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [box])

  return geometry
}

/**
 * Where the thumb sits, in cells.
 *
 * Same proportion OpenTUI's own slider uses: the thumb is the fraction of the
 * content currently on screen, and it travels the leftover track. Returns null
 * when there is nothing to pan, so the caller can skip the row entirely.
 */
export function thumbGeometry(geometry: Geometry): { readonly offset: number; readonly width: number } | null {
  if (geometry.viewport <= 0 || geometry.content <= geometry.viewport) return null
  const width = Math.max(1, Math.round((geometry.viewport / geometry.content) * geometry.viewport))
  const travel = geometry.viewport - width
  if (travel <= 0) return { offset: 0, width }
  const maxLeft = Math.max(1, geometry.content - geometry.viewport)
  return { offset: Math.round((geometry.left / maxLeft) * travel), width }
}

export function HorizontalScrollIndicator({ box }: { box: ScrollBoxRenderable | null }) {
  const c = useTheme().colors
  const geometry = useScrollGeometry(box)
  const thumb = geometry === null ? null : thumbGeometry(geometry)

  /* Nothing to pan: render nothing, and the table keeps the row. */
  if (thumb === null) return null

  return (
    <box height={1} flexDirection="row">
      <text fg={c.textMuted}>{" ".repeat(thumb.offset)}</text>
      <text fg={c.textMuted}>{"─".repeat(thumb.width)}</text>
    </box>
  )
}
