import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUpdateStore } from '@/stores/app/updateStore'
import type { InstallMethod } from '@shared/app/installMethod'
import type { ReleaseCheckResult } from '@shared/app/releases'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { UpdateChannelPicker } from './UpdateChannelPicker'
import { UpdateCheck } from './UpdateCheck'

const installedWith = (method: InstallMethod): void => useUpdateStore.setState({ method })

const answer = (result: ReleaseCheckResult): void => {
  vi.mocked(window.ostia.update.checkRelease).mockResolvedValue(result)
}

const release = (version: string) => ({
  version,
  url: `https://github.com/aurigax-ai/ostia/releases/tag/v${version}`,
})

describe('UpdateChannelPicker', () => {
  let updateInit: ReturnType<typeof useUpdateStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    updateInit = useUpdateStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useUpdateStore.setState(updateInit, true)
    useSettingsStore.setState(settingsInit, true)
  })

  it.each(['tarball', 'local'] as const)(
    'lets the human pick Main on a %s install and forgets the last check result',
    async (method) => {
      const user = userEvent.setup()
      vi.mocked(window.ostia.fs.write).mockClear()
      installedWith(method)
      useUpdateStore.setState({ releaseCheck: { status: 'latest', version: '0.5.9' } })
      render(<UpdateChannelPicker />)

      const picker = screen.getByRole('combobox', { name: 'Update channel' })
      expect(picker).toHaveTextContent('Stable')
      await user.click(picker)
      await user.click(await screen.findByRole('option', { name: 'Main' }))

      expect(useSettingsStore.getState().behavior.updateChannel).toBe('main')
      await waitFor(() =>
        expect(window.ostia.fs.write).toHaveBeenCalledWith(
          expect.any(String),
          expect.stringContaining('"updateChannel": "main"'),
        ),
      )
      expect(useUpdateStore.getState().releaseCheck).toEqual({ status: 'idle' })
      expect(screen.getByRole('combobox', { name: 'Update channel' })).toHaveTextContent('Main')
    },
  )

  it.each(['apt', 'brew', 'dmg'] as const)(
    'keeps a %s install on Stable and says why',
    (method) => {
      installedWith(method)
      useSettingsStore.setState({
        behavior: { ...useSettingsStore.getState().behavior, updateChannel: 'main' },
      })
      render(<UpdateChannelPicker />)

      const picker = screen.getByRole('combobox', { name: 'Update channel' })
      expect(picker).toHaveTextContent('Stable')
      expect(picker).toBeDisabled()
      expect(
        screen.getByText(
          'Main builds come only as the Linux tarball. Installs from apt, Homebrew or the disk image stay on Stable.',
        ),
      ).toBeInTheDocument()
    },
  )

  it('a tarball install on the Main channel is offered the newest main build, and Stable again only releases', async () => {
    const user = userEvent.setup()
    installedWith('tarball')
    render(<UpdateCheck />)

    const picker = screen.getByRole('combobox', { name: 'Update channel' })
    expect(picker).toHaveTextContent('Stable')
    await user.click(picker)
    await user.click(await screen.findByRole('option', { name: 'Main' }))
    expect(screen.getByRole('combobox', { name: 'Update channel' })).toHaveTextContent('Main')

    answer({ status: 'available', release: release('1.1.1-main.5') })
    await user.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(await screen.findByText('Version 1.1.1-main.5 is available')).toBeInTheDocument()

    await user.click(screen.getByRole('combobox', { name: 'Update channel' }))
    await user.click(await screen.findByRole('option', { name: 'Stable' }))
    expect(screen.queryByText('Version 1.1.1-main.5 is available')).toBeNull()

    answer({ status: 'available', release: release('1.1.0') })
    await user.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(await screen.findByText('Version 1.1.0 is available')).toBeInTheDocument()
  })

  it('an apt install keeps the channel picker on Stable and says why', async () => {
    const user = userEvent.setup()
    installedWith('apt')
    useSettingsStore.setState({
      behavior: { ...useSettingsStore.getState().behavior, updateChannel: 'main' },
    })
    render(<UpdateCheck />)

    const picker = screen.getByRole('combobox', { name: 'Update channel' })
    expect(picker).toHaveTextContent('Stable')
    expect(picker).toBeDisabled()
    expect(screen.getByText(/stay on Stable/)).toBeInTheDocument()

    answer({ status: 'available', release: release('1.1.0') })
    await user.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(await screen.findByText('Version 1.1.0 is available')).toBeInTheDocument()
  })

  it('shows nothing in a development run', () => {
    installedWith('dev')
    const { container } = render(<UpdateChannelPicker />)
    expect(container).toBeEmptyDOMElement()
  })
})
