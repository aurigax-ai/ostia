import { type MutableRefObject, type RefObject, useLayoutEffect, useMemo } from 'react'
import { cellBox, rowsToMake } from '@/lib/prompt/promptOverlay'
import type { PromptGeometry } from '@/lib/prompt/usePromptGeometry'

const MAX_LINES = 8

let measureCanvas: HTMLCanvasElement | null = null

function charWidth(fontFamily: string, fontSize: number): number | null {
  measureCanvas ??= document.createElement('canvas')
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = measureCanvas.getContext('2d')
  } catch {
    return null
  }
  if (!ctx) return null
  ctx.font = `${fontSize}px ${fontFamily}`
  const sample = 'W'.repeat(32)
  const width = ctx.measureText(sample).width
  return width > 0 ? width / sample.length : null
}

type CellBox = ReturnType<typeof cellBox>

export interface InputLayout {
  cellHeight: number
  line: CellBox | null
  chipsBox: CellBox | null
  popoverAbove: boolean
  maxLines: number
  cellStyle: {
    fontFamily: string
    fontSize: number
    lineHeight: string
    letterSpacing: string | undefined
  }
}

export function useInputLayout({
  geo,
  fontFamily,
  fontSize,
  visible,
  text,
  areaRef,
  onNeedRowsRef,
}: {
  geo: PromptGeometry | null
  fontFamily: string
  fontSize: number
  visible: boolean
  text: string
  areaRef: RefObject<HTMLTextAreaElement | null>
  onNeedRowsRef: MutableRefObject<(rows: number) => void>
}): InputLayout {
  const metrics = geo?.metrics
  const letterSpacing = useMemo(() => {
    if (!metrics) return 0
    const measured = charWidth(fontFamily, fontSize)
    return measured === null ? 0 : metrics.width - measured
  }, [fontFamily, fontSize, metrics])

  const cellHeight = metrics?.height ?? 0
  const rowsBelow = geo?.placement.rowsBelow ?? 0
  // biome-ignore lint/correctness/useExhaustiveDependencies: text changes the textarea height
  useLayoutEffect(() => {
    const area = areaRef.current
    if (!visible || !area || cellHeight <= 0) return
    const lines = Math.round(area.scrollHeight / cellHeight)
    const rows = rowsToMake(lines, rowsBelow, MAX_LINES)
    if (rows > 0) onNeedRowsRef.current(rows)
  }, [visible, text, cellHeight, rowsBelow])

  const line = geo
    ? cellBox(geo.metrics, geo.placement.row, geo.placement.col, geo.placement.endCol)
    : null
  const chipsBox =
    geo && geo.placement.chipsRow !== null
      ? cellBox(geo.metrics, geo.placement.chipsRow, 0, geo.cols)
      : null
  const popoverAbove = geo ? geo.placement.row >= geo.rows / 2 : true
  const maxLines = Math.min(MAX_LINES, rowsBelow + 1)
  const cellStyle = {
    fontFamily,
    fontSize,
    lineHeight: `${cellHeight}px`,
    letterSpacing: letterSpacing ? `${letterSpacing}px` : undefined,
  }
  return { cellHeight, line, chipsBox, popoverAbove, maxLines, cellStyle }
}
