import type { ReactNode } from "react"
import { useTheme } from "@/theme-context"

/** Borderless terminal-native panel with a subtle, even palette-derived shadow. */
export function ModalSurface({
  width,
  children,
  paddingX = 2,
  paddingY = 1,
  marginTop,
  maxHeight,
}: {
  width: number
  children: ReactNode
  paddingX?: number
  paddingY?: number
  marginTop?: number
  maxHeight?: number
}) {
  const { colors: c } = useTheme()

  return (
    <box width={width + 2} flexDirection="column" marginTop={marginTop} backgroundColor={c.bgShadow} padding={1}>
      <box
        width="100%"
        maxHeight={maxHeight}
        flexDirection="column"
        overflow="hidden"
        backgroundColor={c.bgSurface}
        paddingX={paddingX}
        paddingY={paddingY}
      >
        {children}
      </box>
    </box>
  )
}
