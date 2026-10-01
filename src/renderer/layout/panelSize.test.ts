import { beforeEach, describe, expect, it } from 'vitest'
import { clampFraction, panelFractions, panelKey, sizePanel } from './panelSize'
import {
  createPane,
  resetIds,
  setPaneChat,
  setPaneExtension,
  setPaneView,
  splitOf,
  splitPane,
} from './tree'
import type { LayoutNode, PaneNode, SplitNode } from './types'

beforeEach(() => resetIds())

function extensionPane(extensionId: string): PaneNode {
  const pane = createPane('extension')
  return setPaneExtension(pane, pane.id, extensionId, 'Panel') as PaneNode
}

function sizesOf(root: LayoutNode): number[] {
  return (root as SplitNode).sizes
}

describe('panelKey', () => {
  it('names an extension panel, a view and the chat pane by what they show', () => {
    const view = createPane('view')
    const chat = createPane('chat')

    expect(panelKey(extensionPane('assistant'))).toBe('extension:assistant')
    expect(panelKey(setPaneView(view, view.id, 'deploys', 'Deploys') as PaneNode)).toBe(
      'view:deploys',
    )
    expect(panelKey(setPaneChat(chat, chat.id, 'Chat') as PaneNode)).toBe('chat')
  })

  it('gives no key to terminals, editors and browsers', () => {
    expect(panelKey(createPane('terminal'))).toBeNull()
    expect(panelKey(createPane('editor'))).toBeNull()
    expect(panelKey(createPane('browser'))).toBeNull()
  })
})

describe('clampFraction', () => {
  it('keeps a fraction inside 0.15–0.85', () => {
    expect(clampFraction(0.3)).toBe(0.3)
    expect(clampFraction(0.02)).toBe(0.15)
    expect(clampFraction(0.99)).toBe(0.85)
  })

  it('refuses a fraction that is not a positive number', () => {
    expect(clampFraction(0)).toBeNull()
    expect(clampFraction(Number.NaN)).toBeNull()
    expect(clampFraction(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('panelFractions', () => {
  it('reports the panel share of its split from the dragged sizes', () => {
    const split = splitOf('horizontal', createPane(), extensionPane('assistant'))

    expect(panelFractions(split, [900, 300])).toEqual([
      { key: 'extension:assistant', fraction: 0.25 },
    ])
  })

  it('ignores panels inside nested splits and panes without a key', () => {
    const nested = splitOf('vertical', extensionPane('git'), createPane())
    const split = splitOf('horizontal', createPane(), nested)

    expect(panelFractions(split, [600, 600])).toEqual([])
  })

  it('clamps a panel dragged almost shut', () => {
    const split = splitOf('horizontal', createPane(), extensionPane('assistant'))

    expect(panelFractions(split, [990, 10])).toEqual([
      { key: 'extension:assistant', fraction: 0.15 },
    ])
  })

  it('reports nothing when the sizes do not match the children', () => {
    const split = splitOf('horizontal', createPane(), extensionPane('assistant'))

    expect(panelFractions(split, [1000])).toEqual([])
  })
})

describe('sizePanel', () => {
  it('gives a new panel its remembered fraction of a two-pane split', () => {
    const terminal = createPane()
    const { root, newPaneId } = splitPane(terminal, terminal.id, 'horizontal')
    const next = sizePanel(root, newPaneId as string, 0.3)

    expect(sizesOf(next)[0]).toBeCloseTo(1.4)
    expect(sizesOf(next)[1]).toBeCloseTo(0.6)
  })

  it('takes the room from the pane it was split from, leaving other children alone', () => {
    const a = createPane()
    const b = createPane()
    const panel = extensionPane('assistant')
    const root: SplitNode = { ...splitOf('horizontal', a, b, panel), sizes: [400, 400, 400] }
    const next = sizePanel(root, panel.id, 0.25)

    expect(sizesOf(next)).toEqual([400, 500, 300])
  })

  it('never lets the panel crowd out the pane beside it', () => {
    const a = createPane()
    const b = createPane()
    const panel = extensionPane('assistant')
    const root: SplitNode = { ...splitOf('horizontal', a, b, panel), sizes: [800, 200, 200] }
    const next = sizePanel(root, panel.id, 0.85)

    expect(sizesOf(next)[0]).toBe(800)
    expect(sizesOf(next)[2]).toBeCloseTo(340)
    expect(sizesOf(next)[1]).toBeCloseTo(60)
  })

  it('returns the same root when the pane is not a direct child of a split', () => {
    const lone = createPane()

    expect(sizePanel(lone, lone.id, 0.3)).toBe(lone)
  })

  it('returns the same root when the size already matches', () => {
    const a = createPane()
    const panel = extensionPane('assistant')
    const root: SplitNode = { ...splitOf('horizontal', a, panel), sizes: [700, 300] }

    expect(sizePanel(root, panel.id, 0.3)).toBe(root)
  })

  it('reaches a panel inside a nested split', () => {
    const panel = extensionPane('assistant')
    const inner: SplitNode = { ...splitOf('horizontal', createPane(), panel), sizes: [1, 1] }
    const root = splitOf('vertical', createPane(), inner)
    const next = sizePanel(root, panel.id, 0.2) as SplitNode

    expect(next.children[0]).toBe(root.children[0])
    expect((next.children[1] as SplitNode).sizes[1]).toBeCloseTo(0.4)
  })
})
