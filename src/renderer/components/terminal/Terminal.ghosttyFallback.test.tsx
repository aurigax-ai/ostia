import '@testing-library/jest-dom/vitest'
import { SettingsPanel } from '@/components/settings/SettingsPanel'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { TerminalView } from './Terminal'

vi.mock('@/lib/ghosttyEngine', () => ({
  ghosttyModule: () => null,
  loadGhostty: () => Promise.reject(new Error('wasm blocked')),
  ghosttyFailure: () => 'wasm blocked',
}))

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

describe('a Ghostty engine that cannot start', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
    uiInit = useUIStore.getState()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settingsInit, true)
    useUIStore.setState(uiInit, true)
    vi.clearAllMocks()
  })

  function useGhostty(): void {
    useSettingsStore.setState({
      terminal: { ...useSettingsStore.getState().terminal, renderer: 'ghostty' },
    })
  }

  it('draws the pane with xterm.js instead of showing only an error', async () => {
    useGhostty()
    const { container } = render(<TerminalView workspaceId="w1" paneId="p1" cwd="/home/me" />)
    await waitFor(() => expect(container.querySelector('.xterm-host')).not.toBeNull())
    expect(container.querySelector('.ghostty-host')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says why under the Terminal engine setting', async () => {
    useGhostty()
    useUIStore.setState({ settingsActive: true, settingsTabOpen: true })
    render(<SettingsPanel />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Terminal' }))
    expect(
      screen.getByText('Ghostty could not start, so terminals use xterm.js: wasm blocked'),
    ).toBeVisible()
  })
})
