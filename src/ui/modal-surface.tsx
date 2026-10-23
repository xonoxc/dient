import type { ReactNode } from "react"
import { useTheme } from "@/theme-context"

/**
 * Terminal-native panel. By default it sits on a subtle, even palette-derived
 * shadow. `elevated` raises the panel's surface and lets that surface fill the
 * whole footprint — no border line, no dark shadow frame — so overlays read as
 * a flat card floating above the dimmed screen.
 */
export function ModalSurface({
  width,
  children,
  paddingX = 2,
  paddingY = 1,
  marginTop,
  maxHeight,
  elevated = false,
}: {
  width: number
  children: ReactNode
  paddingX?: number
  paddingY?: number
  marginTop?: number
  maxHeight?: number
  elevated?: boolean
}) {
  const { colors: c } = useTheme()

  /* The elevated surface already provides the outer gap, so skip the inner
     box's vertical padding to keep the card from getting a double margin. */
  const innerPaddingY = elevated ? Math.max(0, paddingY - 1) : paddingY

  return (
    <box
      width={width + 2}
      flexDirection="column"
      marginTop={marginTop}
      backgroundColor={elevated ? c.bgElevated : c.bgShadow}
      padding={1}
    >
      <box
        width="100%"
        maxHeight={maxHeight}
        flexDirection="column"
        overflow="hidden"
        backgroundColor={elevated ? c.bgElevated : c.bgSurface}
        paddingX={paddingX}
        paddingY={innerPaddingY}
      >
        {children}
      </box>
    </box>
  )
}
