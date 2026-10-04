/**
 * Modal layout tests.
 *
 * The confirm dialog is a fixed 62-column band centered in the viewport, and a
 * `<text>` with no wrapping or height cap will happily draw past it. A raw
 * Effect rejection rendered into that body did exactly that, filling the screen
 * with a `FiberFailure` dump and shredding the dialog. These tests pin the
 * layout invariant: whatever a caller passes, the frame stays a dialog.
 *
 * The panel is borderless — `ModalSurface` is a flat card on a shadow ring, not
 * a boxed outline — so the invariant is pinned geometrically: everything the
 * dialog draws lives inside one fixed-width column band, and the band occupies
 * a bounded number of rows that always fit the viewport.
 */
import { describe, expect, test } from "bun:test"
import { useEffect } from "react"
import { makeTheme } from "@/theme"
import { ThemeProvider } from "@/theme-context"
import { renderApp } from "@test/support/render-ui"
import { DialogProvider, useDialog, type ConfirmOptions } from "@/app-context"
import { ModalView } from "@/ui/modal"

/** The dialog is `ModalSurface width={60}` plus the shadow ring's one column
    of padding per side. */
const PANEL_WIDTH = 62

/** `BODY_MAX_LINES` in `ModalView`: the body box is capped, so the dialog can
    never grow past this many rows however long the message is. */
const BODY_MAX_ROWS = 6

const FOOTER = "[(Y)es / (N)o]"

/** Opens one dialog and holds it open so the frame can be inspected. */
function Opener({ body, title }: { body: string; title?: string }) {
  const { confirm } = useDialog()
  useEffect(() => {
    void confirm({ title: title ?? "are you sure", body, okLabel: "ok" } satisfies ConfirmOptions)
    // Render exactly once: the dialog is the subject of the assertions.
  }, [confirm])
  return null
}

const LONG =
  "Connection \"game_service\" failed: connect ECONNREFUSED 127.0.0.1:3309 " +
  "while opening a very long sentence that will not fit on a single row of a " +
  "sixty column dialog and therefore has to wrap somewhere or escape entirely"

async function frameFor(body: string, title?: string, height?: number) {
  return renderApp(
    <ThemeProvider theme={makeTheme("dark")}>
      <DialogProvider>
        <Opener body={body} title={title} />
        <ModalView />
      </DialogProvider>
    </ThemeProvider>,
    height === undefined ? undefined : { height }
  )
}

interface Panel {
  /** Every row of the frame, minus the empty trailing line. */
  readonly rows: ReadonlyArray<string>
  /** Row indices carrying at least one non-blank cell. */
  readonly inked: ReadonlyArray<number>
  /** First inked row — the dialog's title. */
  readonly top: number
  /** Last inked row — the dialog's footer. */
  readonly bottom: number
  /** Column range the dialog may draw into. */
  readonly left: number
  readonly right: number
}

/** Read the dialog's footprint out of a captured frame. */
function panelOf(setup: { captureCharFrame: () => string }, width: number): Panel {
  const rows = setup.captureCharFrame().split("\n").filter(row => row.length > 0)
  const inked: number[] = []
  rows.forEach((row, index) => {
    if (row.trim().length > 0) inked.push(index)
  })
  const left = Math.floor((width - PANEL_WIDTH) / 2)
  return {
    rows,
    inked,
    top: inked[0] ?? -1,
    bottom: inked[inked.length - 1] ?? -1,
    left,
    right: left + PANEL_WIDTH - 1,
  }
}

/** Columns holding a non-blank cell, per row. */
function inkedColumns(row: string): number[] {
  const columns: number[] = []
  for (let i = 0; i < row.length; i++) {
    if (row[i] !== " ") columns.push(i)
  }
  return columns
}

describe("modal layout", () => {
  test("a body far wider than the panel wraps instead of spilling", async () => {
    const setup = await frameFor(LONG)
    try {
      const panel = panelOf(setup, 88)
      expect(panel.inked.length).toBeGreaterThan(0)

      /* Nothing is drawn outside the panel's column band. This is the
         assertion that fails when the body is a single unwrapped <text>: the
         sentence runs off the right edge of the viewport. */
      for (const index of panel.inked) {
        const columns = inkedColumns(panel.rows[index]!)
        expect(Math.min(...columns)).toBeGreaterThanOrEqual(panel.left)
        expect(Math.max(...columns)).toBeLessThanOrEqual(panel.right)
      }

      /* The long text is present, so it wrapped rather than being dropped. */
      const body = panel.inked.length
      expect(body).toBeGreaterThan(3)
      const joined = panel.rows.join("\n")
      expect(joined).toContain("ECONNREFUSED")
      expect(joined).toContain("escape entirely")
    } finally {
      setup.renderer.destroy()
    }
  })

  /* Text already wraps horizontally inside a fixed-width box, so an uncapped
     body did not spill sideways — it grew *downward* with every newline until
     the dialog was pushed off screen entirely. The reported failure was
     exactly this shape: a ~19-line rejection dump. */
  test("a multi-line body cannot push the dialog off a short terminal", async () => {
    const DUMP = Array.from({ length: 18 }, (_, i) => `    at frame ${i} (/app/src/drivers/mysql.ts:35:15)`).join(
      "\n"
    )
    const setup = await frameFor(`(FiberFailure) ConnectionError: Failed to connect\n${DUMP}`, undefined, 12)
    try {
      const panel = panelOf(setup, 88)
      expect(panel.top).toBeGreaterThanOrEqual(0)
      /* Title, capped body, spacer, footer — and the whole thing still fits the
         twelve rows the terminal has. */
      expect(panel.bottom).toBeLessThan(12)
      expect(panel.rows[panel.bottom]).toContain(FOOTER)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("the dialog ends on the row below the body, whatever the body says", async () => {
    const setup = await frameFor(LONG)
    try {
      const panel = panelOf(setup, 88)
      expect(panel.top).toBeGreaterThanOrEqual(0)
      expect(panel.bottom).toBeGreaterThan(panel.top)

      /* The panel ends on its footer, one blank spacer row below the body — the
         rows between the title and the footer are the capped body, so nothing
         unbounded can be appended below it. */
      expect(panel.rows[panel.bottom]).toContain(FOOTER)
      expect(panel.rows[panel.bottom - 1]!.trim()).toBe("")
      expect(panel.bottom - panel.top).toBeLessThanOrEqual(BODY_MAX_ROWS + 3)

      /* Nothing is drawn below the footer. */
      for (const row of panel.rows.slice(panel.bottom + 1)) {
        expect(row.trim()).toBe("")
      }
    } finally {
      setup.renderer.destroy()
    }
  })

  test("a short body still renders normally", async () => {
    const setup = await frameFor("delete this row?")
    try {
      const frame = setup.captureCharFrame()
      expect(frame).toContain("delete this row?")
      expect(frame).toContain("are you sure")
      expect(frame).toContain("ok")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("a body taller than the cap is clipped, not scrolled off the panel", async () => {
    const setup = await frameFor(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"))
    try {
      const panel = panelOf(setup, 88)
      /* First line present, last line clipped away — the cap is doing work. */
      const joined = panel.rows.join("\n")
      expect(joined).toContain("line 0")
      expect(joined).not.toContain("line 39")
      /* Six body rows plus title, spacer and footer. */
      expect(panel.inked.filter(row => panel.rows[row]!.includes("line ")).length).toBe(BODY_MAX_ROWS)
    } finally {
      setup.renderer.destroy()
    }
  })
})