import { WebglAddon } from '@xterm/addon-webgl'
import type { Terminal } from '@xterm/xterm'
import { countUsage } from '@/lib/app/usageCounts'
import { type GpuSlot, gpuBudget } from './gpuBudget'
import type { PauseTerminal } from './ostiaTerminal'

export interface XtermRenderer {
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

export function createXtermRenderer(term: Terminal, gpu: boolean): XtermRenderer {
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen') ?? null
  let addon: WebglAddon | null = null
  let loseContext: (() => void) | null = null
  let disposed = false
  let parked: { parent: Node; sibling: Node | null } | null = null

  const park = (): void => {
    if (!screen?.parentNode || parked || screen.contains(document.activeElement)) return
    parked = { parent: screen.parentNode, sibling: screen.nextSibling }
    screen.remove()
  }

  const unpark = (): void => {
    if (!screen || !parked) return
    const { parent, sibling } = parked
    parked = null
    parent.insertBefore(screen, sibling?.parentNode === parent ? sibling : null)
  }

  const focusTerm = term.focus
  term.focus = () => {
    unpark()
    focusTerm.call(term)
  }

  const release = (): void => {
    const held = addon
    if (!held) return
    addon = null
    held.dispose()
    loseContext?.()
    loseContext = null
  }

  const attach = (): boolean => {
    const before = new Set(screen?.querySelectorAll('canvas'))
    const next = new WebglAddon()
    try {
      term.loadAddon(next)
    } catch {
      next.dispose()
      countUsage('terminal', 'webgl_fallback')
      return false
    }
    addon = next
    loseContext = contextLoser(screen, before)
    next.onContextLoss(() => {
      if (addon !== next) return
      countUsage('terminal', 'webgl_fallback')
      release()
      slot?.lost()
    })
    return true
  }

  const slot: GpuSlot | null = gpu ? gpuBudget.join({ acquire: attach, revoke: release }) : null

  const pause: PauseTerminal = (paused) => {
    if (disposed) return
    if (paused) {
      syncRenderPause(term, true)
      park()
      slot?.hide()
      return
    }
    unpark()
    slot?.show()
    syncRenderPause(term, false)
    term.refresh(0, term.rows - 1)
  }

  return {
    pause,
    dispose: () => {
      disposed = true
      slot?.dispose()
      release()
      unpark()
      term.focus = focusTerm
    },
  }
}
