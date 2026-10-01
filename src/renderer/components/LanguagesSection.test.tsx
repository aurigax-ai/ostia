import type { LanguageServerInfo, LspLog } from '@shared/languageServers'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useLanguageServersStore } from '../stores/languageServersStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { LanguagesSection } from './LanguagesSection'
import { TooltipProvider } from './ui/tooltip'

function server(extra: Partial<LanguageServerInfo> = {}): LanguageServerInfo {
  return {
    key: 'lsp-typescript/typescript',
    extId: 'lsp-typescript',
    extName: 'TypeScript and JavaScript',
    serverId: 'typescript',
    name: 'typescript-language-server',
    languages: ['typescript', 'javascript'],
    kind: 'bundled',
    command: 'server/cli.mjs --stdio',
    enabled: true,
    status: 'idle',
    folders: 0,
    ...extra,
  }
}

const gopls = server({
  key: 'lsp-gopls/gopls',
  extId: 'lsp-gopls',
  extName: 'Go (gopls)',
  serverId: 'gopls',
  name: 'gopls',
  languages: ['go'],
  kind: 'program',
  command: 'gopls',
  program: 'gopls',
  requirement: 'lsp:lsp-gopls/gopls',
  status: 'program-missing',
})

function show(list: LanguageServerInfo[]): void {
  vi.mocked(window.pine.lsp.servers).mockResolvedValue(list)
  render(
    <TooltipProvider>
      <LanguagesSection />
    </TooltipProvider>,
  )
}

describe('LanguagesSection', () => {
  let storeInit: ReturnType<typeof useLanguageServersStore.getState>
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>

  beforeAll(() => {
    storeInit = useLanguageServersStore.getState()
    workspacesInit = useWorkspacesStore.getState()
  })

  afterEach(() => {
    cleanup()
    useLanguageServersStore.setState(storeInit, true)
    useWorkspacesStore.setState(workspacesInit, true)
  })

  it('says so when no extension provides a server', async () => {
    show([])
    expect(await screen.findByText(/No language servers/)).toBeInTheDocument()
  })

  it('lists each server with its extension, languages, kind, command and status', async () => {
    show([
      server({ status: 'running', folders: 2 }),
      server({ key: 'a/one', name: 'one', status: 'running', folders: 1 }),
      server({ key: 'a/off', name: 'off-server', status: 'off', enabled: false }),
      server({ key: 'a/crashed', name: 'crashed-server', status: 'crashed' }),
      server({
        key: 'a/pending',
        name: 'pending-server',
        status: 'pending-approval',
        enabled: false,
      }),
    ])
    const row = await screen.findByRole('listitem', { name: 'typescript-language-server' })
    expect(within(row).getByText('Bundled')).toBeInTheDocument()
    expect(
      within(row).getByText(/TypeScript and JavaScript · typescript, javascript/),
    ).toBeInTheDocument()
    expect(within(row).getByText('server/cli.mjs --stdio')).toBeInTheDocument()
    expect(within(row).getByText('Running (2 folders)')).toBeInTheDocument()
    expect(
      within(screen.getByRole('listitem', { name: 'one' })).getByText('Running (1 folder)'),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('listitem', { name: 'off-server' })).getByText('Off'),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('listitem', { name: 'crashed-server' })).getByText('Crashed'),
    ).toBeInTheDocument()
    const pending = screen.getByRole('listitem', { name: 'pending-server' })
    expect(within(pending).getByText('Waiting for approval')).toBeInTheDocument()
    expect(within(pending).getByRole('switch')).toHaveAttribute('data-disabled')
  })

  it('switches a server off through main and shows what main answered', async () => {
    show([server()])
    const user = userEvent.setup()
    vi.mocked(window.pine.lsp.setEnabled).mockResolvedValue([
      server({ enabled: false, status: 'off' }),
    ])
    const toggle = await screen.findByRole('switch', { name: 'Enable typescript-language-server' })
    expect(toggle).toBeChecked()
    await user.click(toggle)
    expect(window.pine.lsp.setEnabled).toHaveBeenCalledWith('lsp-typescript/typescript', false)
    expect(await screen.findByText('Off')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Restart typescript-language-server' }),
    ).toBeDisabled()
  })

  it('restarts a server on the human’s click', async () => {
    show([server({ status: 'crashed' })])
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', { name: 'Restart typescript-language-server' }),
    )
    expect(window.pine.lsp.restart).toHaveBeenCalledWith('lsp-typescript/typescript')
  })

  it('offers to install a missing program through the system extension', async () => {
    useWorkspacesStore.setState({ activeWorkspaceId: 'ws-1' })
    vi.mocked(window.pine.system.requirements).mockResolvedValue({
      missing: [{ program: 'gopls', package: 'gopls' }],
      hint: { command: 'sudo pacman -S --needed gopls', packages: ['gopls'] },
      canInstall: true,
    })
    show([gopls])
    const user = userEvent.setup()
    expect(await screen.findByText('Program missing: gopls')).toBeInTheDocument()
    expect(screen.getByText('Program')).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Install gopls' }))
    expect(window.pine.system.requirements).toHaveBeenCalledWith('lsp:lsp-gopls/gopls')
    expect(window.pine.system.installRequirements).toHaveBeenCalledWith(
      'lsp:lsp-gopls/gopls',
      'ws-1',
    )
  })

  it('shows the install command to copy when the system extension cannot run it', async () => {
    vi.mocked(window.pine.system.requirements).mockResolvedValue({
      missing: [{ program: 'gopls', package: 'gopls' }],
      hint: { command: 'sudo pacman -S --needed gopls', packages: ['gopls'] },
      canInstall: false,
    })
    show([gopls])
    expect(await screen.findByText('sudo pacman -S --needed gopls')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Install gopls' })).toBeNull()
  })

  it('explains why a server cannot run in the sandbox', async () => {
    show([
      server({
        status: 'sandbox-unavailable',
        sandboxProblem: 'program-unreadable',
        sandboxDetail: '/home/u/.cargo/bin',
      }),
    ])
    expect(await screen.findByText('Not available in this sandbox')).toBeInTheDocument()
    expect(screen.getByText(/The sandbox cannot read \/home\/u\/\.cargo\/bin/)).toBeInTheDocument()
  })

  it('opens the in-memory log only when asked, with events, stderr and failed requests', async () => {
    const log: LspLog = {
      entries: [
        { at: 1, kind: 'start', pid: 4242, sandboxed: false },
        { at: 2, kind: 'initialized', name: 'tsserver', version: '5.3.0' },
        { at: 3, kind: 'stderr', text: 'warming up' },
        { at: 4, kind: 'exit', code: 1, signal: null },
        { at: 5, kind: 'restart', attempt: 1, limit: 5, delayMs: 500 },
        { at: 6, kind: 'stop', reason: 'idle' },
        { at: 7, kind: 'exit', code: null, signal: 'SIGTERM' },
        { at: 8, kind: 'crashed' },
      ],
      errors: { 'textDocument/hover': 3 },
    }
    vi.mocked(window.pine.lsp.log).mockResolvedValue(log)
    show([server()])
    const user = userEvent.setup()
    const open = await screen.findByRole('button', {
      name: 'Show the log of typescript-language-server',
    })
    expect(window.pine.lsp.log).not.toHaveBeenCalled()
    await user.click(open)
    const dialog = await screen.findByRole('dialog')
    expect(window.pine.lsp.log).toHaveBeenCalledWith('lsp-typescript/typescript')
    for (const line of [
      'Started (pid 4242)',
      'Initialized tsserver 5.3.0',
      'warming up',
      'Exited (code 1)',
      'Restarting in 500 ms (1/5)',
      'Stopping: no open files',
      'Exited (SIGTERM)',
      'Crashed too often; not restarting',
      'textDocument/hover',
    ]) {
      expect(await within(dialog).findByText(line)).toBeInTheDocument()
    }
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
