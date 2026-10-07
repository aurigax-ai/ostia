import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RAIL_MOTION_FALLBACK_MS } from '../lib/railMotion'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { type Workspace, useWorkspacesStore } from '../stores/workspacesStore'
import { DeckRail } from './DeckRail'

function seedWorkspaces(): void {
  const workspaces: Workspace[] = [
    { id: 's1', name: 'alpha', kind: 'terminal', workDir: '/home/alpha', state: 'idle' },
  ]
  useWorkspacesStore.setState({ workspaces, activeWorkspaceId: 's1' })
}

function rail(): HTMLElement {
  const el = document.getElementById('deck-rail')
  if (!el) throw new Error('rail not rendered')
  return el
}

function setCollapsed(collapsed: boolean): void {
  act(() => useUIStore.getState().setRailCollapsed(collapsed))
}

describe('DeckRail toggle motion', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    uiInit = useUIStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    useWorkspacesStore.setState(workspacesInit, true)
    useUIStore.setState(uiInit, true)
    useSettingsStore.setState(settingsInit, true)
    document.documentElement.removeAttribute('data-rail-resizing')
  })

  it('keeps the full width while sliding out, and narrows once when the slide ends', () => {
    seedWorkspaces()
    render(<DeckRail />)

    setCollapsed(true)
    expect(rail()).not.toHaveClass('collapsed')
    expect(rail()).toHaveAttribute('data-rail-motion', 'closing')

    fireEvent.animationEnd(rail().firstElementChild as Element, {
      animationName: 'rail-content-fade',
    })
    expect(rail()).toHaveAttribute('data-rail-motion', 'closing')

    fireEvent.animationEnd(rail(), { animationName: 'rail-slide' })
    expect(rail()).toHaveClass('collapsed')
    expect(rail()).not.toHaveAttribute('data-rail-motion')
  })

  it('widens once at the start and slides in over it', () => {
    seedWorkspaces()
    useUIStore.setState({ railCollapsed: true })
    render(<DeckRail />)
    expect(rail()).toHaveClass('collapsed')

    setCollapsed(false)
    expect(rail()).not.toHaveClass('collapsed')
    expect(rail()).toHaveAttribute('data-rail-motion', 'opening')

    fireEvent.animationEnd(rail(), { animationName: 'rail-slide' })
    expect(rail()).not.toHaveAttribute('data-rail-motion')
    expect(rail()).not.toHaveClass('collapsed')
  })

  it('reopens mid-slide without ever narrowing', () => {
    seedWorkspaces()
    render(<DeckRail />)

    setCollapsed(true)
    setCollapsed(false)
    expect(rail()).not.toHaveClass('collapsed')
    expect(rail()).toHaveAttribute('data-rail-motion', 'opening')

    fireEvent.animationEnd(rail(), { animationName: 'rail-slide' })
    expect(rail()).not.toHaveClass('collapsed')
    expect(rail()).not.toHaveAttribute('data-rail-motion')
  })

  it('turns around from where the slide is instead of restarting it', () => {
    const fake = (animationName: string) => ({
      animationName,
      currentTime: 60 as number | null,
      effect: { getComputedTiming: () => ({ duration: 180 }) },
    })
    const running = [fake('rail-slide'), fake('rail-content-fade'), fake('rail-follow')]
    const other = { ...fake('waiting-ring'), currentTime: 5 }
    Object.defineProperty(document, 'getAnimations', {
      configurable: true,
      value: () => [...running, other],
    })
    try {
      seedWorkspaces()
      render(<DeckRail />)

      setCollapsed(true)
      expect(rail()).toHaveAttribute('data-rail-motion', 'closing')
      setCollapsed(false)
      expect(rail()).toHaveAttribute('data-rail-motion', 'opening')
      expect(running.map((a) => a.currentTime)).toEqual([120, 120, 120])
      expect(other.currentTime).toBe(5)
    } finally {
      Reflect.deleteProperty(document, 'getAnimations')
    }
  })

  it('settles on its own when the animation never reports an end', () => {
    vi.useFakeTimers()
    seedWorkspaces()
    render(<DeckRail />)

    setCollapsed(true)
    expect(rail()).not.toHaveClass('collapsed')
    act(() => vi.advanceTimersByTime(RAIL_MOTION_FALLBACK_MS))
    expect(rail()).toHaveClass('collapsed')
    expect(rail()).not.toHaveAttribute('data-rail-motion')
  })

  it('jumps straight to the new width with no animation when motion is reduced', () => {
    seedWorkspaces()
    act(() => useSettingsStore.getState().setMotion('reduced'))
    render(<DeckRail />)

    setCollapsed(true)
    expect(rail()).toHaveClass('collapsed')
    expect(rail()).not.toHaveAttribute('data-rail-motion')

    setCollapsed(false)
    expect(rail()).not.toHaveClass('collapsed')
    expect(rail()).not.toHaveAttribute('data-rail-motion')
  })

  it('jumps straight to the new width when the OS asks for reduced motion', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: true,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    )
    seedWorkspaces()
    render(<DeckRail />)

    setCollapsed(true)
    expect(rail()).toHaveClass('collapsed')
    expect(rail()).not.toHaveAttribute('data-rail-motion')
    vi.restoreAllMocks()
  })

  it('does not animate a collapse that happens while dragging the edge', () => {
    seedWorkspaces()
    render(<DeckRail />)
    document.documentElement.setAttribute('data-rail-resizing', '')

    setCollapsed(true)
    expect(rail()).toHaveClass('collapsed')
    expect(rail()).not.toHaveAttribute('data-rail-motion')
  })
})
