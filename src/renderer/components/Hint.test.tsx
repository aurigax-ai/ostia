import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'
import { Hint, useShortcutHint } from './Hint'
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
  it('shows the bound key next to the label on hover', async () => {
    render(
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
