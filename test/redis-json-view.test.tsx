import { describe, expect, test } from "bun:test"
import { useRef } from "react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { makeTheme } from "@/theme"
import { ThemeProvider } from "@/theme-context"
import { RedisTextPanel } from "@/redis/redis-views"
import { renderApp } from "@test/support/render-ui"

const VALUE = JSON.stringify({ id: 1, name: "Ada", active: true, none: null }, null, 2)

function JsonPanel() {
  const scrollRef = useRef<ScrollBoxRenderable | null>(null)
  return (
    <ThemeProvider theme={makeTheme("dark")}>
      <box width={80} height={20}>
        <RedisTextPanel value={VALUE} width={80} scrollRef={scrollRef} json />
      </box>
    </ThemeProvider>
  )
}

describe("RedisJSON panel", () => {
  test("colors JSON tokens with the theme instead of plain text", async () => {
    const setup = await renderApp(<JsonPanel />, { width: 80, height: 20 })
    const colors = makeTheme("dark").colors
    try {
      const spans = setup.captureSpans().lines.flatMap(line => line.spans)
      const colorOf = (text: string) => spans.find(span => span.text === text)?.fg?.toInts()

      expect(colorOf('"id"')).toEqual(colors.info.toInts())
      expect(colorOf('"Ada"')).toEqual(colors.success.toInts())
      expect(colorOf("1")).toEqual(colors.warning.toInts())
      expect(colorOf("true")).toEqual(colors.accent.toInts())
      expect(colorOf("{")).toEqual(colors.textMuted.toInts())
    } finally {
      setup.renderer.destroy()
    }
  })
})
