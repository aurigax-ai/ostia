import '@testing-library/jest-dom/vitest'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { WorkspacesSection } from './WorkspacesSection'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

describe('WorkspacesSection', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settingsInit, true)
    vi.mocked(window.ostia.fs.stat).mockReset()
    vi.useRealTimers()
  })

  it('writes each switch to the workspaces settings', async () => {
    render(<WorkspacesSection />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('switch', { name: 'Start in the current folder' }))
    await user.click(screen.getByRole('switch', { name: 'Confirm before closing' }))
    await user.click(screen.getByRole('switch', { name: 'Confirm before quitting' }))
    await user.click(screen.getByRole('switch', { name: 'Wrap long titles' }))

    expect(useSettingsStore.getState().workspaces).toMatchObject({
      inheritFolder: true,
      confirmClose: false,
      confirmQuit: false,
      wrapTitles: true,
    })
  })

  it('picks where new workspaces appear', async () => {
    render(<WorkspacesSection />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('combobox', { name: 'Position' }))
    await user.click(await screen.findByRole('option', { name: 'At the top' }))

    expect(useSettingsStore.getState().workspaces.placement).toBe('top')
  })

  it('warns when the default folder is not a directory and falls back to ~ when cleared', async () => {
    vi.mocked(window.ostia.fs.stat).mockResolvedValue(null)
    render(<WorkspacesSection />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Default folder' }), {
      target: { value: '/nope' },
    })
    expect(useSettingsStore.getState().workspaces.defaultFolder).toBe('/nope')
    expect(await screen.findByText('Not a folder, or outside your home folder.')).toBeVisible()

    fireEvent.change(screen.getByRole('textbox', { name: 'Default folder' }), {
      target: { value: '' },
    })
    expect(useSettingsStore.getState().workspaces.defaultFolder).toBe('~')
  })

  it('shows no warning for an existing directory', async () => {
    vi.mocked(window.ostia.fs.stat).mockResolvedValue('dir')
    render(<WorkspacesSection />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Default folder' }), {
      target: { value: '~/code' },
    })
    await waitFor(() => expect(window.ostia.fs.stat).toHaveBeenCalledWith('~/code'))

    expect(screen.queryByText('Not a folder, or outside your home folder.')).toBeNull()
  })
})
