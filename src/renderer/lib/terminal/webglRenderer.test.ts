import type { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const addons = vi.hoisted(() => [] as FakeWebglAddon[])
const loadFailures = vi.hoisted(() => ({ remaining: 0 }))

interface FakeWebglAddon {
  disposed: boolean
  canvas: HTMLCanvasElement | null
  loseContext: ReturnType<typeof vi.fn>
  loseListeners: (() => void)[]
  fireContextLoss(): void
  dispose(): void
}

vi.mock('@/lib/app/usageCounts', () => ({ countUsage: vi.fn() }))

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class implements FakeWebglAddon {
    disposed = false
    canvas: HTMLCanvasElement | null = null
    loseContext = vi.fn()
    loseListeners: (() => void)[] = []
    constructor() {
      addons.push(this)
    }
    activate(term: { element: HTMLElement }): void {
      if (loadFailures.remaining > 0) {
        loadFailures.remaining--
        throw new Error('WebGL2 not supported')
      }
      const canvas = document.createElement('canvas')
      const loseContext = this.loseContext
      Object.defineProperty(canvas, 'getContext', {
        value: (kind: string) =>
          kind === 'webgl2'
            ? {
                getExtension: (name: string) =>
                  name === 'WEBGL_lose_context' ? { loseContext } : null,
              }
            : null,
      })
      term.element.querySelector('.xterm-screen')?.appendChild(canvas)
      this.canvas = canvas
    }
    onContextLoss(listener: () => void): { dispose(): void } {
      this.loseListeners.push(listener)
      return { dispose: () => {} }
    }
    fireContextLoss(): void {
      for (const listener of [...this.loseListeners]) listener()
    }
    dispose(): void {
      if (this.disposed) return
      this.disposed = true
      this.canvas?.remove()
    }
  },
}))

const { MAX_WEBGL_TERMINALS, createWebglRenderer } = await import('./webglRenderer')

interface FakeTerm {
  term: Terminal
  viewport: HTMLElement
  screen: HTMLElement
  intersections: boolean[]
  loaded: FakeWebglAddon[]
}

const renderers: { dispose(): void }[] = []

function fakeTerm(): FakeTerm {
  const element = document.createElement('div')
  const viewport = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  const scrollbar = document.createElement('div')
  viewport.append(screen, scrollbar)
  element.appendChild(viewport)
  document.body.appendChild(element)
  const intersections: boolean[] = []
  const loaded: FakeWebglAddon[] = []
  const term = {
    element,
    loadAddon: (addon: FakeWebglAddon & { activate(t: unknown): void }) => {
      addon.activate(term)
      loaded.push(addon)
    },
    _core: {
      _renderService: {
        _handleIntersectionChange: (entry: { isIntersecting: boolean }) =>
          intersections.push(entry.isIntersecting),
      },
    },
  }
  return { term: term as unknown as Terminal, viewport, screen, intersections, loaded }
}

function create(t: FakeTerm) {
  const renderer = createWebglRenderer(t.term)
  renderers.push(renderer)
  return renderer
}

function live(t: FakeTerm): FakeWebglAddon[] {
  return t.loaded.filter((a) => !a.disposed)
}

function liveTotal(): number {
  return addons.filter((a) => a.canvas && !a.disposed).length
}

afterEach(() => {
  for (const r of renderers.splice(0)) r.dispose()
  document.body.replaceChildren()
  addons.length = 0
  loadFailures.remaining = 0
})

describe('createWebglRenderer', () => {
  it('holds WebGL only while the pane is shown', () => {
    const t = fakeTerm()
    const renderer = create(t)
    expect(t.loaded).toHaveLength(0)

    renderer.pause(false)
    expect(live(t)).toHaveLength(1)
    expect(t.screen.parentElement).toBe(t.viewport)

    renderer.pause(true)
    expect(live(t)).toHaveLength(0)
    expect(t.loaded[0].loseContext).toHaveBeenCalledTimes(1)
    expect(t.screen.isConnected).toBe(false)

    renderer.pause(true, { releaseRenderer: true })
    renderer.pause(false)
    expect(t.loaded).toHaveLength(2)
    expect(live(t)).toHaveLength(1)
  })

  it('stops drawing a hidden pane before dropping WebGL and attaches before drawing again', () => {
    const t = fakeTerm()
    const renderer = create(t)
    const order: string[] = []
    const intersect = t.term as unknown as {
      _core: { _renderService: { _handleIntersectionChange(e: { isIntersecting: boolean }): void } }
    }
    intersect._core._renderService._handleIntersectionChange = (e) =>
      order.push(e.isIntersecting ? 'draw' : 'stop')
    const load = t.term.loadAddon.bind(t.term)
    t.term.loadAddon = (a) => {
      order.push('attach')
      load(a)
    }

    renderer.pause(false)
    const first = t.loaded[0]
    const dispose = first.dispose.bind(first)
    first.dispose = () => {
      order.push('detach')
      dispose()
    }
    renderer.pause(true)

    expect(order).toEqual(['attach', 'draw', 'stop', 'detach'])
  })

  it('takes a hidden screen off the page and puts it back in the same place', () => {
    const t = fakeTerm()
    const renderer = create(t)
    renderer.pause(true)
    expect(t.screen.isConnected).toBe(false)
    renderer.pause(true, { releaseRenderer: true })
    renderer.pause(false)
    expect([...t.viewport.children]).toEqual([t.screen, t.viewport.lastElementChild])
    expect(t.screen.nextElementSibling).not.toBeNull()

    renderer.pause(true)
    renderer.dispose()
    expect(t.screen.parentElement).toBe(t.viewport)
  })

  it('keeps a pane created hidden on the DOM renderer without drawing', () => {
    const t = fakeTerm()
    const renderer = create(t)
    renderer.pause(true)
    expect(t.loaded).toHaveLength(0)
    expect(t.intersections).toEqual([false])
    expect(t.screen.isConnected).toBe(false)
  })

  it('never keeps more than the WebGL budget and hands freed slots to shown panes', () => {
    const terms = Array.from({ length: MAX_WEBGL_TERMINALS + 3 }, () => fakeTerm())
    const shown = terms.map((t) => {
      const renderer = create(t)
      renderer.pause(false)
      return renderer
    })
    expect(liveTotal()).toBe(MAX_WEBGL_TERMINALS)
    expect(terms.slice(MAX_WEBGL_TERMINALS).every((t) => t.loaded.length === 0)).toBe(true)

    shown[0].pause(true)
    expect(liveTotal()).toBe(MAX_WEBGL_TERMINALS)
    expect(live(terms[MAX_WEBGL_TERMINALS])).toHaveLength(1)

    shown[MAX_WEBGL_TERMINALS + 1].pause(true)
    shown[1].dispose()
    expect(liveTotal()).toBe(MAX_WEBGL_TERMINALS)
    expect(terms[MAX_WEBGL_TERMINALS + 1].loaded).toHaveLength(0)
    expect(live(terms[MAX_WEBGL_TERMINALS + 2])).toHaveLength(1)
  })

  it('reattaches WebGL after the context is lost while shown', () => {
    const t = fakeTerm()
    const renderer = create(t)
    renderer.pause(false)
    t.loaded[0].fireContextLoss()

    expect(t.loaded[0].disposed).toBe(true)
    expect(t.loaded).toHaveLength(2)
    expect(live(t)).toHaveLength(1)
  })

  it('recovers a pane that fell back to the DOM renderer the next time it is shown', () => {
    const t = fakeTerm()
    const renderer = create(t)
    loadFailures.remaining = 1
    renderer.pause(false)
    expect(live(t)).toHaveLength(0)
    expect(t.screen.parentElement).toBe(t.viewport)

    renderer.pause(true)
    renderer.pause(false)
    expect(live(t)).toHaveLength(1)
  })

  it('ignores a late context loss from a renderer it already dropped', () => {
    const t = fakeTerm()
    const renderer = create(t)
    renderer.pause(false)
    const first = t.loaded[0]
    renderer.pause(true)
    renderer.pause(false)
    first.fireContextLoss()

    expect(t.loaded).toHaveLength(2)
    expect(live(t)).toEqual([t.loaded[1]])
  })

  it('does not reattach when the context is lost after the pane was hidden', () => {
    const t = fakeTerm()
    const renderer = create(t)
    renderer.pause(false)
    const first = t.loaded[0]
    renderer.pause(true)
    first.fireContextLoss()

    expect(t.loaded).toHaveLength(1)
    expect(live(t)).toHaveLength(0)
  })

  it('keeps one renderer through rapid show and hide', () => {
    const t = fakeTerm()
    const renderer = create(t)
    for (let i = 0; i < 25; i++) {
      renderer.pause(i % 3 === 0)
      renderer.pause(false)
    }
    expect(live(t)).toHaveLength(1)
    expect(
      t.loaded.slice(0, -1).every((a) => a.disposed && a.loseContext.mock.calls.length === 1),
    ).toBe(true)
  })

  it('does nothing after it is disposed, even for a pane waiting on the budget', () => {
    const holders = Array.from({ length: MAX_WEBGL_TERMINALS }, () => fakeTerm())
    const held = holders.map((t) => {
      const renderer = create(t)
      renderer.pause(false)
      return renderer
    })
    const t = fakeTerm()
    const renderer = create(t)
    renderer.pause(false)
    renderer.dispose()
    held[0].pause(true)
    renderer.pause(false)

    expect(t.loaded).toHaveLength(0)
    expect(liveTotal()).toBe(MAX_WEBGL_TERMINALS - 1)
  })

  it('drops WebGL when a shown pane is disposed and loses its context in the middle of it', () => {
    const t = fakeTerm()
    const renderer = create(t)
    renderer.pause(false)
    const first = t.loaded[0]
    renderer.dispose()
    first.fireContextLoss()

    expect(t.loaded).toHaveLength(1)
    expect(first.disposed).toBe(true)
    expect(first.loseContext).toHaveBeenCalledTimes(1)
  })
})
