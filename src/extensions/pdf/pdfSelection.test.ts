import { describe, expect, it } from 'vitest'
import {
  contains,
  dragIntent,
  dragRect,
  inPageUnits,
  isClick,
  linkAt,
  pixelRect,
  type TextBox,
  textInRect,
  transformedRect,
} from './pdfSelection'

const text = { overText: true, pageHasText: true, cropMode: false, alt: false }

describe('dragIntent', () => {
  it('selects text only when the drag starts on a text span of a page with text', () => {
    expect(dragIntent(text)).toBe('text')
    expect(dragIntent({ ...text, overText: false })).toBe('crop')
    expect(dragIntent({ ...text, pageHasText: false })).toBe('crop')
  })

  it('crops over text with the crop toggle or Alt', () => {
    expect(dragIntent({ ...text, cropMode: true })).toBe('crop')
    expect(dragIntent({ ...text, alt: true })).toBe('crop')
  })
})

describe('dragRect', () => {
  const page = { width: 400, height: 300 }

  it('spans the two corners in any direction and stays inside the page', () => {
    expect(dragRect({ x: 50.2, y: 40 }, { x: 10, y: 90.7 }, page)).toEqual({
      x: 10,
      y: 40,
      width: 41,
      height: 51,
    })
    expect(dragRect({ x: -20, y: 10 }, { x: 500, y: 400 }, page)).toEqual({
      x: 0,
      y: 10,
      width: 400,
      height: 290,
    })
  })

  it('is no region for a click or a sliver', () => {
    expect(dragRect({ x: 5, y: 5 }, { x: 6, y: 6 }, page)).toBeNull()
    expect(dragRect({ x: 5, y: 5 }, { x: 100, y: 7 }, page)).toBeNull()
    expect(isClick({ x: 5, y: 5 }, { x: 7, y: 6 })).toBe(true)
    expect(isClick({ x: 5, y: 5 }, { x: 12, y: 5 })).toBe(false)
  })
})

describe('textInRect', () => {
  const box = (str: string, x: number, y: number, width: number): TextBox => ({
    text: str,
    rect: { x, y, width, height: 10 },
  })
  const boxes = [
    box('Item', 10, 100, 30),
    box('Qty', 200, 101, 20),
    box('Standing desk', 10, 120, 80),
    box('4', 200, 120, 6),
    box('Total due', 10, 300, 50),
    box('  ', 120, 120, 10),
  ]

  it('joins what lies inside by lines in reading order, spacing items that stand apart', () => {
    expect(textInRect(boxes, { x: 0, y: 90, width: 260, height: 50 })).toBe(
      'Item Qty\nStanding desk 4',
    )
  })

  it('takes an item when the rectangle holds its centre and nothing else', () => {
    expect(textInRect(boxes, { x: 0, y: 90, width: 60, height: 50 })).toBe('Item\nStanding desk')
    expect(textInRect(boxes, { x: 0, y: 0, width: 100, height: 50 })).toBe('')
  })

  it('does not add a space between items that touch', () => {
    const touching = [box('Hel', 0, 0, 20), box('lo', 20.5, 0, 10)]
    expect(textInRect(touching, { x: 0, y: 0, width: 50, height: 20 })).toBe('Hello')
  })
})

describe('regions', () => {
  it('maps a region to canvas pixels inside the canvas', () => {
    expect(
      pixelRect({ x: 10, y: 20, width: 30, height: 40 }, 2, { width: 200, height: 200 }),
    ).toEqual({
      x: 20,
      y: 40,
      width: 60,
      height: 80,
    })
    expect(
      pixelRect({ x: 90, y: 90, width: 30, height: 30 }, 2, { width: 100, height: 100 }),
    ).toEqual({
      x: 99,
      y: 99,
      width: 1,
      height: 1,
    })
  })

  it('names a region in page units at scale 1', () => {
    expect(inPageUnits({ x: 30, y: 60, width: 150, height: 45 }, 1.5)).toEqual({
      x: 20,
      y: 40,
      width: 100,
      height: 30,
    })
  })
})

describe('links', () => {
  it('finds the link under a point', () => {
    const links = [
      {
        rect: { x: 0, y: 0, width: 10, height: 10 },
        target: { kind: 'url' as const, url: 'https://a' },
      },
      {
        rect: { x: 20, y: 0, width: 10, height: 10 },
        target: { kind: 'step' as const, step: 'next' as const },
      },
    ]
    expect(linkAt(links, { x: 25, y: 5 })?.target).toEqual({ kind: 'step', step: 'next' })
    expect(linkAt(links, { x: 15, y: 5 })).toBeNull()
    expect(contains(links[0].rect, { x: 10, y: 10 })).toBe(true)
  })

  it('maps an annotation rectangle through the page transform, upright', () => {
    const flip = [1.5, 0, 0, -1.5, 0, 1188]
    expect(transformedRect([30, 40, 10, 5], flip)).toEqual({
      x: 15,
      y: 1128,
      width: 30,
      height: 52.5,
    })
  })
})
