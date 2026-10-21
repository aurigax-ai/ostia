export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export interface TextBox {
  text: string
  rect: Rect
}

export type DragIntent = 'text' | 'crop'

export interface DragStart {
  overText: boolean
  pageHasText: boolean
  cropMode: boolean
  alt: boolean
}

const MIN_REGION = 4
const CLICK_DISTANCE = 4
const LINE_OVERLAP = 0.5
const WORD_GAP = 0.2

export function dragIntent(start: DragStart): DragIntent {
  if (start.cropMode || start.alt || !start.pageHasText || !start.overText) return 'crop'
  return 'text'
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

export function dragRect(a: Point, b: Point, bounds: Size): Rect | null {
  const left = clamp(Math.min(a.x, b.x), 0, bounds.width)
  const top = clamp(Math.min(a.y, b.y), 0, bounds.height)
  const right = clamp(Math.max(a.x, b.x), 0, bounds.width)
  const bottom = clamp(Math.max(a.y, b.y), 0, bounds.height)
  const x = Math.floor(left)
  const y = Math.floor(top)
  const width = Math.ceil(right) - x
  const height = Math.ceil(bottom) - y
  return width < MIN_REGION || height < MIN_REGION ? null : { x, y, width, height }
}

export function isClick(from: Point, to: Point): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) < CLICK_DISTANCE
}

export function contains(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  )
}

function center(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

function sameLine(a: Rect, b: Rect): boolean {
  const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return overlap > Math.min(a.height, b.height) * LINE_OVERLAP
}

export function textInRect(boxes: readonly TextBox[], region: Rect): string {
  const inside = boxes.filter((box) => box.text.trim() !== '' && contains(region, center(box.rect)))
  const lines: TextBox[][] = []
  for (const box of [...inside].sort((a, b) => a.rect.y - b.rect.y)) {
    const line = lines.find((row) => sameLine(row[0].rect, box.rect))
    if (line) line.push(box)
    else lines.push([box])
  }
  return lines
    .sort((a, b) => a[0].rect.y - b[0].rect.y)
    .map((line) => {
      const ordered = line.sort((a, b) => a.rect.x - b.rect.x)
      return ordered
        .map((box, index) => {
          const before = ordered[index - 1]
          if (!before) return box.text
          const gap = box.rect.x - (before.rect.x + before.rect.width)
          const apart = gap > box.rect.height * WORD_GAP
          const spaced = before.text.endsWith(' ') || box.text.startsWith(' ')
          return `${apart && !spaced ? ' ' : ''}${box.text}`
        })
        .join('')
        .trim()
    })
    .join('\n')
}

export function pixelRect(region: Rect, factor: number, bounds: Size): Rect {
  const x = clamp(Math.floor(region.x * factor), 0, Math.max(0, bounds.width - 1))
  const y = clamp(Math.floor(region.y * factor), 0, Math.max(0, bounds.height - 1))
  const right = clamp(Math.ceil((region.x + region.width) * factor), x + 1, bounds.width)
  const bottom = clamp(Math.ceil((region.y + region.height) * factor), y + 1, bounds.height)
  return { x, y, width: right - x, height: bottom - y }
}

export function inPageUnits(region: Rect, scale: number): Rect {
  const round = (value: number): number => Math.round((value / scale) * 100) / 100
  return {
    x: round(region.x),
    y: round(region.y),
    width: round(region.width),
    height: round(region.height),
  }
}

export type LinkTarget =
  | { kind: 'url'; url: string }
  | { kind: 'dest'; dest: string | readonly unknown[] }
  | { kind: 'step'; step: 'next' | 'previous' | 'first' | 'last' }

export interface PageLink {
  rect: Rect
  target: LinkTarget
}

export function linkAt(links: readonly PageLink[], point: Point): PageLink | null {
  return links.find((link) => contains(link.rect, point)) ?? null
}

export function transformedRect(rect: readonly number[], matrix: readonly number[]): Rect {
  const [a, b, c, d, e, f] = matrix
  const corners = [
    [rect[0], rect[1]],
    [rect[2], rect[3]],
  ].map(([x, y]) => ({ x: a * x + c * y + e, y: b * x + d * y + f }))
  const left = Math.min(corners[0].x, corners[1].x)
  const top = Math.min(corners[0].y, corners[1].y)
  return {
    x: left,
    y: top,
    width: Math.abs(corners[1].x - corners[0].x),
    height: Math.abs(corners[1].y - corners[0].y),
  }
}
