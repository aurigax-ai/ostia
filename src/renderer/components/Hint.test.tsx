import { act, cleanup, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderSettled } from '../../../test/render'
import { useSettingsStore } from '../stores/settingsStore'
import { Hint, useShortcutHint } from './Hint'
import { ItemDescription, ItemTitle } from './ui/item'
import { TooltipProvider } from './ui/tooltip'

vi.mock('../platform', () => ({ platform: 'darwin', isMac: true, isLinux: false }))

const initialSettings = useSettingsStore.getState()

afterEach(() => {
  cleanup()
  useSettingsStore.setState(initialSettings, true)
})

describe('useShortcutHint', () => {
  it('returns the default binding, null for unbound or missing commands', () => {
    expect(renderHook(() => useShortcutHint('view.toggleRail')).result.current).toBe('⌘B')
    expect(renderHook(() => useShortcutHint('terminal.scrollLineUp')).result.current).toBeNull()
    expect(renderHook(() => useShortcutHint(undefined)).result.current).toBeNull()
  })

  it('follows a rebinding and an unbinding', () => {
    const { result } = renderHook(() => useShortcutHint('view.toggleRail'))
    act(() => {
      useSettingsStore.setState({
        keybindings: { 'view.toggleRail': 'Cmd+Shift+K' },
      })
    })
    expect(result.current).toBe('⌘⇧K')
    act(() => {
      useSettingsStore.setState({ keybindings: { 'view.toggleRail': null } })
    })
    expect(result.current).toBeNull()
  })
})

describe('Hint', () => {
  it('anchors on an item title and description, which take the trigger ref', async () => {
    const title = createRef<HTMLDivElement>()
    const description = createRef<HTMLParagraphElement>()
    await renderSettled(
      <>
        <ItemTitle ref={title}>Title</ItemTitle>
        <ItemDescription ref={description}>Description</ItemDescription>
        <Hint label="Full title">
          <ItemTitle>Hinted title</ItemTitle>
        </Hint>
        <Hint label="Full description">
          <ItemDescription>Hinted description</ItemDescription>
        </Hint>
      </>,
    )
    expect(title.current).toBe(screen.getByText('Title'))
    expect(description.current).toBe(screen.getByText('Description'))
    expect(screen.getByText('Hinted title')).toHaveAttribute('data-slot', 'tooltip-trigger')
    expect(screen.getByText('Hinted description')).toHaveAttribute('data-slot', 'tooltip-trigger')
  })

  it('shows the bound key next to the label on hover', async () => {
    await renderSettled(
      <TooltipProvider delay={0}>
        <Hint label="Toggle Sidebar" command="view.toggleRail">
          <button type="button">x</button>
        </Hint>
      </TooltipProvider>,
    )
    await userEvent.hover(screen.getByRole('button'))
    expect(await screen.findByText('⌘B')).toBeInTheDocument()
    expect(screen.getAllByText('Toggle Sidebar').length).toBeGreaterThan(0)
  })
})
