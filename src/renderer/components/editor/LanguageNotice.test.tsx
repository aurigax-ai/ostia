import { useExtensionsStore } from '@/stores/extensionsStore'
import { useLanguageNoticeStore } from '@/stores/languageNoticeStore'
import { useLanguageServersStore } from '@/stores/languageServersStore'
import { useUIStore } from '@/stores/uiStore'
import type { ExtensionSuggestion } from '@shared/extensions/extensionSuggestions'
import type { LanguageServerInfo } from '@shared/languageServers'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { LanguageNotice, serverNoticeFor } from './LanguageNotice'

const state = { marketplaces: [], installed: [] }

function server(extra: Partial<LanguageServerInfo> = {}): LanguageServerInfo {
  return {
    key: 'lsp-rust-analyzer/rust-analyzer',
    extId: 'lsp-rust-analyzer',
    extName: 'Rust (rust-analyzer)',
    serverId: 'rust-analyzer',
    name: 'rust-analyzer',
    languages: ['rust'],
    kind: 'download',
    command: 'rust-analyzer',
    program: 'rust-analyzer',
    enabled: true,
    status: 'idle',
    folders: 0,
    ...extra,
  }
}

const install: ExtensionSuggestion = {
  kind: 'install',
  extId: 'lsp-rust-analyzer',
  name: 'Rust (rust-analyzer)',
  files: '.rs',
  others: 0,
}

function suggest(suggestion: ExtensionSuggestion | null): void {
  vi.mocked(window.ostia.suggestions.forFile).mockResolvedValue(suggestion)
}

describe('LanguageNotice', () => {
  let servers: ReturnType<typeof useLanguageServersStore.getState>
  let notices: ReturnType<typeof useLanguageNoticeStore.getState>
  let extensions: ReturnType<typeof useExtensionsStore.getState>
  let ui: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    servers = useLanguageServersStore.getState()
    notices = useLanguageNoticeStore.getState()
    extensions = useExtensionsStore.getState()
    ui = useUIStore.getState()
  })

  afterEach(() => {
    cleanup()
    useLanguageServersStore.setState(servers, true)
    useLanguageNoticeStore.setState(notices, true)
    useExtensionsStore.setState(extensions, true)
    useUIStore.setState(ui, true)
  })

  it('shows nothing when main has no suggestion for the file', async () => {
    suggest(null)
    render(<LanguageNotice paneId="p1" filePath="/work/notes.txt" />)
    await waitFor(() =>
      expect(window.ostia.suggestions.forFile).toHaveBeenCalledWith('p1', '/work/notes.txt'),
    )
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('offers to install the suggested extension and installs it on the human’s click', async () => {
    suggest(install)
    vi.mocked(window.ostia.suggestions.install).mockResolvedValue({ ok: true, state })
    render(<LanguageNotice paneId="p1" filePath="/work/main.rs" />)
    const notice = await screen.findByRole('status', { name: 'Language features' })
    expect(notice).toHaveTextContent('Rust (rust-analyzer) adds language features for .rs files.')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Install' }))
    expect(window.ostia.suggestions.install).toHaveBeenCalledWith('lsp-rust-analyzer')
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(window.ostia.suggestions.dismiss).not.toHaveBeenCalled()
  })

  it('says why an install failed and keeps the offer', async () => {
    suggest(install)
    vi.mocked(window.ostia.suggestions.install).mockResolvedValue({
      ok: false,
      error: 'git-missing',
      state,
    })
    render(<LanguageNotice paneId="p1" filePath="/work/main.rs" />)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Install' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not install it: git is not installed.',
    )
    expect(screen.getByRole('button', { name: 'Install' })).toBeEnabled()
  })

  it('remembers No for that extension and hides the notice', async () => {
    suggest({ ...install, others: 2 })
    render(<LanguageNotice paneId="p1" filePath="/work/main.rs" />)
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Settings → Extensions lists 2 more.',
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'No' }))
    expect(window.ostia.suggestions.dismiss).toHaveBeenCalledWith('lsp-rust-analyzer')
    expect(screen.queryByRole('status')).toBeNull()
    expect(window.ostia.suggestions.install).not.toHaveBeenCalled()
  })

  it('opens Settings at an installed extension that is turned off, and the review of one waiting for approval', async () => {
    suggest({ ...install, kind: 'enable', pending: false })
    const first = render(<LanguageNotice paneId="p1" filePath="/work/main.rs" />)
    expect(await screen.findByRole('status')).toHaveTextContent('is installed but turned off')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open Settings' }))
    expect(useUIStore.getState()).toMatchObject({
      settingsActive: true,
      settingsSection: 'extensions',
      settingsExtension: 'lsp-rust-analyzer',
    })
    first.unmount()

    suggest({ ...install, kind: 'enable', pending: true })
    render(<LanguageNotice paneId="p1" filePath="/work/main.rs" />)
    expect(await screen.findByRole('status')).toHaveTextContent('is waiting for your approval')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Review' }))
    expect(useExtensionsStore.getState().reviewing).toBe('lsp-rust-analyzer')
  })

  it('shows one extension’s offer in one pane per window session', async () => {
    suggest(install)
    render(<LanguageNotice paneId="p1" filePath="/work/main.rs" />)
    await screen.findByRole('status')
    render(<LanguageNotice paneId="p2" filePath="/work/lib.rs" />)
    await waitFor(() =>
      expect(window.ostia.suggestions.forFile).toHaveBeenCalledWith('p2', '/work/lib.rs'),
    )
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })

  it('shows a quiet line while a server for the file is being fetched', async () => {
    suggest(null)
    vi.mocked(window.ostia.lsp.servers).mockResolvedValue([
      server({ status: 'downloading', progress: 40 }),
    ])
    render(<LanguageNotice paneId="p1" filePath="/work/main.rs" />)
    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent('Downloading rust-analyzer… 40%')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('points at Settings → Languages when the server cannot start', async () => {
    suggest(null)
    vi.mocked(window.ostia.lsp.servers).mockResolvedValue([
      server({ status: 'toolchain-missing', name: 'gopls', languages: ['go'], program: 'gopls' }),
    ])
    render(<LanguageNotice paneId="p1" filePath="/work/main.go" />)
    expect(await screen.findByRole('status')).toHaveTextContent(
      'gopls cannot start: Go is not installed.',
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open Settings' }))
    expect(useUIStore.getState().settingsSection).toBe('languageServers')
  })
})

describe('serverNoticeFor', () => {
  it('picks a server of the file’s language that is being fetched or cannot start', () => {
    expect(serverNoticeFor([server({ status: 'download-failed' })], '/p/a.rs')?.status).toBe(
      'download-failed',
    )
    expect(serverNoticeFor([server({ status: 'installing' })], '/p/a.rs')?.status).toBe(
      'installing',
    )
    expect(serverNoticeFor([server({ status: 'program-missing' })], '/p/a.py')).toBeNull()
    expect(serverNoticeFor([server({ status: 'idle' })], '/p/a.rs')).toBeNull()
    expect(serverNoticeFor([server({ status: 'off', enabled: false })], '/p/a.rs')).toBeNull()
  })

  it('stays quiet when another server already runs for the language', () => {
    expect(
      serverNoticeFor(
        [server({ status: 'program-missing' }), server({ key: 'x/y', status: 'running' })],
        '/p/a.rs',
      ),
    ).toBeNull()
  })
})
