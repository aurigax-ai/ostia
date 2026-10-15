import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { act, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderSettled } from '../../../../test/render'
import { DeckRail } from './DeckRail'

const css = readFileSync(resolve(process.cwd(), 'src/renderer/index.css'), 'utf8')

function ruleBody(selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  if (start < 0) throw new Error(`no rule for ${selector}`)
  return css.slice(start, css.indexOf('\n}', start))
}

const VIEWPORT_HEIGHT = 200
const LIST_HEIGHT = 1000
const RAIL_WIDTH = 240

function seedManyWorkspaces(): void {
  const workspaces: Workspace[] = Array.from({ length: 30 }, (_, i) => ({
    id: `s${i}`,
    name: `workspace ${i}`,
    kind: 'terminal',
    workDir: `/home/w${i}`,
    state: 'idle',
  }))
  useWorkspacesStore.setState({ workspaces, activeWorkspaceId: 's0' })
}

async function renderRailViewport(): Promise<HTMLElement> {
  const { container } = await renderSettled(<DeckRail />)
  const viewport = container.querySelector<HTMLElement>(
    '.scroll-quiet.rail-scroll > [data-slot="scroll-area-viewport"]',
  )
  if (!viewport) throw new Error('rail viewport not found')
  const geometry = {
    clientHeight: VIEWPORT_HEIGHT,
    scrollHeight: LIST_HEIGHT,
    clientWidth: RAIL_WIDTH,
    scrollWidth: RAIL_WIDTH,
  }
  for (const [name, value] of Object.entries(geometry)) {
    Object.defineProperty(viewport, name, { configurable: true, value })
  }
  return viewport
}

function userScroll(viewport: HTMLElement, top: number): void {
  Object.defineProperty(viewport, 'scrollTop', { configurable: true, value: top })
  fireEvent.wheel(viewport)
  fireEvent.scroll(viewport)
}

function railScrollbar(viewport: HTMLElement): HTMLElement | null {
  return viewport.parentElement?.querySelector('[data-slot="scroll-area-scrollbar"]') ?? null
}

describe('DeckRail scroll list', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    useWorkspacesStore.setState(workspacesInit, true)
  })

  it('keeps the workspace rows inside the fading scroll area', async () => {
    seedManyWorkspaces()
    const viewport = await renderRailViewport()
    expect(viewport.querySelector('.workspaces')).toHaveTextContent('workspace 29')
  })

  it('marks only the edges that have more rows past them', async () => {
    seedManyWorkspaces()
    const viewport = await renderRailViewport()

    await act(async () => userScroll(viewport, 0))
    expect(viewport).not.toHaveAttribute('data-overflow-y-start')
    expect(viewport).toHaveAttribute('data-overflow-y-end')

    await act(async () => userScroll(viewport, 400))
    expect(viewport).toHaveAttribute('data-overflow-y-start')
    expect(viewport).toHaveAttribute('data-overflow-y-end')

    await act(async () => userScroll(viewport, LIST_HEIGHT - VIEWPORT_HEIGHT))
    expect(viewport).toHaveAttribute('data-overflow-y-start')
    expect(viewport).not.toHaveAttribute('data-overflow-y-end')
  })

  it('shows the scrollbar while the list scrolls and hides it after a short idle', async () => {
    seedManyWorkspaces()
    const viewport = await renderRailViewport()
    vi.useFakeTimers()

    await act(async () => {
      fireEvent.scroll(viewport)
    })
    const scrollbar = railScrollbar(viewport)
    expect(scrollbar).not.toBeNull()
    expect(scrollbar).not.toHaveAttribute('data-scrolling')

    await act(async () => userScroll(viewport, 120))
    expect(railScrollbar(viewport)).toHaveAttribute('data-scrolling')

    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    await act(async () => userScroll(viewport, 240))
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    expect(railScrollbar(viewport)).toHaveAttribute('data-scrolling')

    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    expect(railScrollbar(viewport)).not.toHaveAttribute('data-scrolling')
  })

  it('fades the edges with the shadcn utility and keeps the scrollbar gutter', () => {
    const viewportRule = ruleBody('.scroll-quiet > [data-slot="scroll-area-viewport"]')
    expect(viewportRule).toContain('@apply scroll-fade;')
    expect(viewportRule).toContain('padding-inline-end: var(--scroll-gutter);')
    expect(ruleBody('.scroll-quiet > [data-slot="scroll-area-scrollbar"]')).toContain(
      'width: var(--scroll-gutter);',
    )
  })

  it('hides the scrollbar at rest by opacity alone, timed by the motion tokens', () => {
    const rest = ruleBody('.scroll-quiet > [data-slot="scroll-area-scrollbar"]')
    const scrolling = ruleBody(
      '.scroll-quiet > [data-slot="scroll-area-scrollbar"][data-scrolling]',
    )
    expect(rest).toContain('opacity: 0;')
    expect(rest).toContain('transition: opacity var(--motion-base-exit) var(--ease-in);')
    expect(scrolling).toContain('opacity: 1;')
    expect(scrolling).toContain('transition: opacity var(--motion-fast) var(--ease-out);')
  })
})
