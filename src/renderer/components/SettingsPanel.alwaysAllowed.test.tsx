import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { SettingsPanel } from './SettingsPanel'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

describe('SettingsPanel always allowed permissions', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
    uiInit = useUIStore.getState()
  })

  afterEach(() => {
    cleanup()
    vi.mocked(window.ostia.approvals.removeAlways).mockClear()
    useSettingsStore.setState(settingsInit, true)
    useUIStore.setState(uiInit, true)
  })

  async function openAgents() {
    useUIStore.setState({ settingsActive: true, settingsTabOpen: true })
    render(<SettingsPanel />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Agents' }))
    return user
  }

  it('lists each always allowed permission and removes it through main', async () => {
    useSettingsStore.setState({ capabilities: { grants: ['send-other-pane', 'browse'] } })
    const user = await openAgents()

    const group = screen.getByRole('heading', { name: 'Always allowed' }).closest('section')
    if (!group) throw new Error('no Always allowed group')
    expect(within(group).getByText('send messages to other panes')).toBeInTheDocument()
    const rows = within(group).getAllByRole('button', { name: 'Remove' })
    expect(rows).toHaveLength(2)
    await user.click(rows[1])

    expect(window.ostia.approvals.removeAlways).toHaveBeenCalledWith('browse')
  })

  it('says nothing is always allowed when there are no grants', async () => {
    await openAgents()
    expect(screen.getByText(/Nothing is always allowed/)).toBeInTheDocument()
  })
})
