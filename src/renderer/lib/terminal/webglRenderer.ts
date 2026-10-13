import { countUsage } from '@/lib/app/usageCounts'
import { WebglAddon } from '@xterm/addon-webgl'
import type { Terminal } from '@xterm/xterm'
import type { PauseTerminal } from './ostiaTerminal'

export const MAX_WEBGL_TERMINALS = 14

export interface WebglRenderer {
  pause: PauseTerminal
  dispose(): void
}

interface RenderServiceInternals {
  _core?: {
    _renderService?: {
      _handleIntersectionChange?: (entry: {
        isIntersecting: boolean
        intersectionRatio: number
      }) => void
    }
  }
}

const holders = new Set<object>()
const waiting = new Set<() => void>()

function wakeWaiting(): void {
  for (const attach of waiting) {
    if (holders.size >= MAX_WEBGL_TERMINALS) return
    attach()
  }
}

function syncRenderPause(term: Terminal, paused: boolean): void {
  const internals = term as unknown as RenderServiceInternals
  internals._core?._renderService?._handleIntersectionChange?.({
    isIntersecting: !paused,
    intersectionRatio: paused ? 0 : 1,
  })
}

function contextLoser(
  screen: HTMLElement | null,
  before: ReadonlySet<HTMLCanvasElement>,
): (() => void) | null {
  if (!screen) return null
  for (const canvas of screen.querySelectorAll('canvas')) {
    if (before.has(canvas)) continue
    const lose = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')
    if (lose) return () => lose.loseContext()
  }
  return null
}

export function createWebglRenderer(term: Terminal): WebglRenderer {
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen') ?? null
  const slot = {}
  let addon: WebglAddon | null = null
  let loseContext: (() => void) | null = null
  let shown = false
  let disposed = false
  let parked: { parent: Node; sibling: Node | null } | null = null

  const park = (): void => {
    if (!screen?.parentNode || parked) return
    parked = { parent: screen.parentNode, sibling: screen.nextSibling }
    screen.remove()
  }

  const unpark = (): void => {
    if (!screen || !parked) return
    const { parent, sibling } = parked
    parked = null
    parent.insertBefore(screen, sibling?.parentNode === parent ? sibling : null)
  }

  const release = (): void => {
    const held = addon
    if (!held) return
    addon = null
    held.dispose()
    loseContext?.()
    loseContext = null
    holders.delete(slot)
    wakeWaiting()
  }

  const attach = (): void => {
    waiting.delete(attach)
    if (!shown || addon) return
    if (holders.size >= MAX_WEBGL_TERMINALS) {
      waiting.add(attach)
      return
    }
    const before = new Set(screen?.querySelectorAll('canvas'))
    const next = new WebglAddon()
    try {
      term.loadAddon(next)
    } catch {
      next.dispose()
      countUsage('terminal', 'webgl_fallback')
      return
    }
    addon = next
    loseContext = contextLoser(screen, before)
    holders.add(slot)
    next.onContextLoss(() => {
      if (addon !== next) return
      countUsage('terminal', 'webgl_fallback')
      release()
      attach()
    })
  }

  const pause: PauseTerminal = (paused) => {
    if (disposed) return
    shown = !paused
    if (paused) {
      waiting.delete(attach)
      syncRenderPause(term, true)
      park()
      release()
      return
    }
    unpark()
    attach()
    syncRenderPause(term, false)
  }

  return {
    pause,
    dispose: () => {
      disposed = true
      waiting.delete(attach)
      release()
      unpark()
    },
  }
}
