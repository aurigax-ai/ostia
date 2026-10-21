import type { InstallMethod } from '@shared/app/installMethod'
import type { ReleaseCheckResult } from '@shared/app/releases'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUpdateStore } from '@/stores/app/updateStore'
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

  it.each(['tarball', 'local'] as const)(
    'lets the human pick Beta on a %s install',
    async (method) => {
      const user = userEvent.setup()
      installedWith(method)
      render(<UpdateChannelPicker />)
      await user.click(screen.getByRole('combobox', { name: 'Update channel' }))
      expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
        'Stable',
        'Beta',
        'Main',
      ])
      await user.click(screen.getByRole('option', { name: 'Beta' }))
      expect(useSettingsStore.getState().behavior.updateChannel).toBe('beta')
      expect(screen.getByRole('combobox', { name: 'Update channel' })).toHaveTextContent('Beta')
      expect(screen.queryByRole('switch', { name: 'Receive beta updates' })).toBeNull()
    },
  )

  it('keeps an apt install on Stable and says why', () => {
    installedWith('apt')
    useSettingsStore.setState({
      behavior: { ...useSettingsStore.getState().behavior, updateChannel: 'main' },
    })
    render(<UpdateChannelPicker />)

    const picker = screen.getByRole('combobox', { name: 'Update channel' })
    expect(picker).toHaveTextContent('Stable')
    expect(picker).toBeDisabled()
    expect(
      screen.getByText(
        'Beta and Main builds come only as the Linux tarball. Installs from apt stay on Stable.',
      ),
    ).toBeInTheDocument()
  })

  it.each(['dmg', 'brew'] as const)(
    'offers Receive beta updates on a %s install instead of the channel list',
    async (method) => {
      const user = userEvent.setup()
      vi.mocked(window.ostia.fs.write).mockClear()
      installedWith(method)
      useUpdateStore.setState({ releaseCheck: { status: 'latest', version: '0.5.12' } })
      render(<UpdateChannelPicker />)

      expect(screen.queryByRole('combobox', { name: 'Update channel' })).toBeNull()
      const beta = screen.getByRole('switch', { name: 'Receive beta updates' })
      expect(beta).not.toBeChecked()
      expect(screen.queryByText(/brew upgrade --cask ostia/)).toBeNull()

      await user.click(beta)
      expect(useSettingsStore.getState().behavior.updateChannel).toBe('beta')
      await waitFor(() =>
        expect(window.ostia.fs.write).toHaveBeenCalledWith(
          expect.any(String),
          expect.stringContaining('"updateChannel": "beta"'),
        ),
      )
      expect(useUpdateStore.getState().releaseCheck).toEqual({ status: 'idle' })
      expect(screen.getByRole('switch', { name: 'Receive beta updates' })).toBeChecked()
      expect(screen.queryAllByText(/brew upgrade --cask ostia/)).toHaveLength(
        method === 'brew' ? 1 : 0,
      )

      await user.click(screen.getByRole('switch', { name: 'Receive beta updates' }))
      expect(useSettingsStore.getState().behavior.updateChannel).toBe('stable')
    },
  )

  it('warns a brew install on Beta that brew upgrade --cask ostia returns to the release', async () => {
    installedWith('brew')
    useSettingsStore.setState({
      behavior: { ...useSettingsStore.getState().behavior, updateChannel: 'beta' },
    })
    render(<UpdateChannelPicker />)
    await act(async () => {})
    expect(
      screen.getByText(
        'Running brew upgrade --cask ostia yourself installs the Homebrew release again, which can be older than this beta.',
      ),
    ).toBeInTheDocument()
  })

  it('says a release candidate stays until a release catches up once Beta is off, and only then', async () => {
    const running = async (version: string) => {
      const info = await window.ostia.info()
      vi.mocked(window.ostia.info).mockResolvedValue({ ...info, version })
    }
    const note =
      'You’re on beta 0.6.0-rc.2. It stays until a release catches up; nothing is downgraded.'
    await running('0.6.0-rc.2+sha.1a2b3c')
    installedWith('dmg')
    const { unmount } = render(<UpdateChannelPicker />)
    expect(await screen.findByText(note)).toBeInTheDocument()
    act(() =>
      useSettingsStore.setState({
        behavior: { ...useSettingsStore.getState().behavior, updateChannel: 'beta' },
      }),
    )
    expect(screen.queryByText(note)).toBeNull()
    unmount()

    await running('0.5.12')
    useSettingsStore.setState({
      behavior: { ...useSettingsStore.getState().behavior, updateChannel: 'stable' },
    })
    render(<UpdateChannelPicker />)
    await waitFor(() => expect(window.ostia.info).toHaveBeenCalled())
    expect(screen.queryByText(/You’re on beta/)).toBeNull()
  })

  it('shows Beta off on a dmg install whose settings still say main', async () => {
    installedWith('dmg')
    useSettingsStore.setState({
      behavior: { ...useSettingsStore.getState().behavior, updateChannel: 'main' },
    })
    render(<UpdateChannelPicker />)
    await act(async () => {})
    expect(screen.getByRole('switch', { name: 'Receive beta updates' })).not.toBeChecked()
  })

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
