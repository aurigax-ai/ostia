import type { Terminal } from '@xterm/xterm'
import { Terminal as Xterm } from '@xterm/xterm'
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

const { GPU_CONTEXT_BUDGET } = await import('./gpuBudget')
const { createXtermRenderer } = await import('./xtermRenderer')

interface FakeTerm {
  term: Terminal
  viewport: HTMLElement
  screen: HTMLElement
  intersections: boolean[]
  refreshes: [number, number][]
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
  const refreshes: [number, number][] = []
  const loaded: FakeWebglAddon[] = []
  const term = {
    element,
    rows: 24,
    refresh: (start: number, end: number) => refreshes.push([start, end]),
    focus: () => {},
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
  return { term: term as unknown as Terminal, viewport, screen, intersections, refreshes, loaded }
}

function create(t: FakeTerm, gpu = true) {
  const renderer = createXtermRenderer(t.term, gpu)
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

describe('createXtermRenderer', () => {
  it('parks and pauses a hidden pane on the DOM renderer without ever making a WebGL context', () => {
    const t = fakeTerm()
    const renderer = create(t, false)
    renderer.pause(false)
    expect(t.screen.parentElement).toBe(t.viewport)
    renderer.pause(true)
    expect(t.screen.isConnected).toBe(false)
    expect(t.intersections).toEqual([true, false])

    renderer.pause(false)
    expect(t.screen.parentElement).toBe(t.viewport)
    expect(t.intersections).toEqual([true, false, true])
    expect(t.loaded).toHaveLength(0)

    renderer.pause(true)
    renderer.dispose()
    expect(t.screen.parentElement).toBe(t.viewport)
  })

  it('redraws every row once a parked pane is back on the page, so its listeners measure it again', () => {
    for (const gpu of [false, true]) {
      const t = fakeTerm()
      const renderer = create(t, gpu)
      renderer.pause(true)
      expect(t.refreshes).toEqual([])
      const refresh = t.term.refresh.bind(t.term)
      t.term.refresh = (start, end) => {
        expect(t.screen.isConnected).toBe(true)
        refresh(start, end)
      }
      renderer.pause(false)
      expect(t.refreshes).toEqual([[0, 23]])
    }
  })

  it('leaves the WebGL budget to GPU panes when GPU acceleration is off', () => {
    for (let i = 0; i < GPU_CONTEXT_BUDGET - 1; i++) create(fakeTerm()).pause(false)
    const dom = fakeTerm()
    create(dom, false).pause(false)
    const last = fakeTerm()
    create(last).pause(false)
    expect(live(last)).toHaveLength(1)
    expect(dom.loaded).toHaveLength(0)
    expect(liveTotal()).toBe(GPU_CONTEXT_BUDGET)
  })

  it('keeps WebGL for a hidden pane and draws it again without a new context', () => {
    const t = fakeTerm()
    const renderer = create(t)
    expect(t.loaded).toHaveLength(0)

    renderer.pause(false)
    expect(live(t)).toHaveLength(1)
    expect(t.screen.parentElement).toBe(t.viewport)

    renderer.pause(true)
    expect(live(t)).toHaveLength(1)
    expect(t.loaded[0].loseContext).not.toHaveBeenCalled()
    expect(t.screen.isConnected).toBe(false)

    renderer.pause(false)
    expect(t.loaded).toHaveLength(1)
    expect(live(t)).toHaveLength(1)
    expect(t.intersections).toEqual([true, false, true])
  })

  it('keeps the screen of a pane that still holds the keyboard, such as one under the history layer', () => {
    const t = fakeTerm()
    const input = document.createElement('textarea')
    t.screen.appendChild(input)
    const renderer = create(t, false)
    renderer.pause(false)
    input.focus()
    renderer.pause(true)
    expect(t.screen.isConnected).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(t.intersections).toEqual([true, false])

    input.blur()
    renderer.pause(true)
    expect(t.screen.isConnected).toBe(false)
  })

  it('puts a parked screen back when the terminal is asked for focus', () => {
    const t = fakeTerm()
    const focused: boolean[] = []
    const focus = vi.fn(() => focused.push(t.screen.isConnected))
    t.term.focus = focus
    const renderer = create(t, false)
    renderer.pause(true)
    expect(t.screen.isConnected).toBe(false)
    t.term.focus()
    expect(focused).toEqual([true])
    expect(t.screen.isConnected).toBe(true)
    renderer.dispose()
    expect(t.term.focus).toBe(focus)
  })

  it('takes a hidden screen off the page and puts it back in the same place', () => {
    const t = fakeTerm()
    const renderer = create(t)
    renderer.pause(true)
    expect(t.screen.isConnected).toBe(false)
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

  it('releases the least recently shown hidden pane only when the budget is full', () => {
    const terms = Array.from({ length: GPU_CONTEXT_BUDGET + 1 }, () => fakeTerm())
    const renderers = terms.map((t) => create(t))
    for (const renderer of renderers.slice(0, GPU_CONTEXT_BUDGET)) {
      renderer.pause(false)
      renderer.pause(true)
    }
    renderers[0].pause(false)
    renderers[0].pause(true)
    expect(liveTotal()).toBe(GPU_CONTEXT_BUDGET)

    renderers[GPU_CONTEXT_BUDGET].pause(false)
    expect(liveTotal()).toBe(GPU_CONTEXT_BUDGET)
    expect(live(terms[GPU_CONTEXT_BUDGET])).toHaveLength(1)
    expect(live(terms[1])).toHaveLength(0)
    expect(terms[1].loaded[0].loseContext).toHaveBeenCalledTimes(1)
    expect(live(terms[0])).toHaveLength(1)
  })

  it('stops drawing a pane before its hidden WebGL is released for another', () => {
    const terms = Array.from({ length: GPU_CONTEXT_BUDGET + 1 }, () => fakeTerm())
    const renderers = terms.map((t) => create(t))
    const order: string[] = []
    const intersect = terms[0].term as unknown as {
      _core: { _renderService: { _handleIntersectionChange(e: { isIntersecting: boolean }): void } }
    }
    intersect._core._renderService._handleIntersectionChange = (e) =>
      order.push(e.isIntersecting ? 'draw' : 'stop')
    for (const renderer of renderers.slice(0, GPU_CONTEXT_BUDGET)) renderer.pause(false)
    const first = terms[0].loaded[0]
    const dispose = first.dispose.bind(first)
    first.dispose = () => {
      order.push('detach')
      dispose()
    }
    renderers[0].pause(true)
    renderers[GPU_CONTEXT_BUDGET].pause(false)

    expect(order).toEqual(['draw', 'stop', 'detach'])
  })

  it('makes a shown pane wait while every slot is on screen and serves it once one hides', () => {
    const terms = Array.from({ length: GPU_CONTEXT_BUDGET + 2 }, () => fakeTerm())
    const shown = terms.map((t) => {
      const renderer = create(t)
      renderer.pause(false)
      return renderer
    })
    expect(liveTotal()).toBe(GPU_CONTEXT_BUDGET)
    expect(terms.slice(GPU_CONTEXT_BUDGET).every((t) => t.loaded.length === 0)).toBe(true)

    shown[0].pause(true)
    expect(liveTotal()).toBe(GPU_CONTEXT_BUDGET)
    expect(live(terms[0])).toHaveLength(0)
    expect(live(terms[GPU_CONTEXT_BUDGET + 1])).toHaveLength(1)

    shown[GPU_CONTEXT_BUDGET].pause(true)
    shown[1].dispose()
    expect(liveTotal()).toBe(GPU_CONTEXT_BUDGET - 1)
    expect(terms[GPU_CONTEXT_BUDGET].loaded).toHaveLength(0)
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
    first.fireContextLoss()
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
    expect(t.loaded).toHaveLength(1)
    expect(live(t)).toHaveLength(1)
  })

  it('does nothing after it is disposed, even for a pane waiting on the budget', () => {
    const holders = Array.from({ length: GPU_CONTEXT_BUDGET }, () => fakeTerm())
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
    expect(liveTotal()).toBe(GPU_CONTEXT_BUDGET)
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

  it('relies on a render service pause hook that the real xterm still has', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const term = new Xterm()
    term.open(host)
    const internals = term as unknown as {
      _core: { _renderService: Record<string, unknown> }
    }
    expect(typeof internals._core._renderService._handleIntersectionChange).toBe('function')
    term.dispose()
  })
})
