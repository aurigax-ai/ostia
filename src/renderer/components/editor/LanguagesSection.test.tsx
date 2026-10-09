import { TooltipProvider } from '@/components/ui/tooltip'
import { useLanguageServersStore } from '@/stores/extensions/languageServersStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { LanguageServerInfo, LspLog } from '@shared/languageServers'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { LanguagesSection } from './LanguagesSection'

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
  vi.mocked(window.ostia.lsp.servers).mockResolvedValue(list)
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
    vi.mocked(window.ostia.lsp.setEnabled).mockResolvedValue([
      server({ enabled: false, status: 'off' }),
    ])
    const toggle = await screen.findByRole('switch', { name: 'Enable typescript-language-server' })
    expect(toggle).toBeChecked()
    await user.click(toggle)
    expect(window.ostia.lsp.setEnabled).toHaveBeenCalledWith('lsp-typescript/typescript', false)
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
    expect(window.ostia.lsp.restart).toHaveBeenCalledWith('lsp-typescript/typescript')
  })

  it('offers to install a missing program through the system extension', async () => {
    useWorkspacesStore.setState({ activeWorkspaceId: 'ws-1' })
    vi.mocked(window.ostia.system.requirements).mockResolvedValue({
      missing: [{ program: 'gopls', package: 'gopls' }],
      hint: { command: 'sudo pacman -S --needed gopls', packages: ['gopls'] },
      canInstall: true,
    })
    show([gopls])
    const user = userEvent.setup()
    expect(await screen.findByText('Program missing: gopls')).toBeInTheDocument()
    expect(screen.getByText('Program')).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Install gopls' }))
    expect(window.ostia.system.requirements).toHaveBeenCalledWith('lsp:lsp-gopls/gopls')
    expect(window.ostia.system.installRequirements).toHaveBeenCalledWith(
      'lsp:lsp-gopls/gopls',
      'ws-1',
    )
  })

  it('shows the install command to copy when the system extension cannot run it', async () => {
    vi.mocked(window.ostia.system.requirements).mockResolvedValue({
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
        { at: 9, kind: 'stop', reason: 'off' },
      ],
      errors: { 'textDocument/hover': 3 },
    }
    vi.mocked(window.ostia.lsp.log).mockResolvedValue(log)
    show([server()])
    const user = userEvent.setup()
    const open = await screen.findByRole('button', {
      name: 'Show the log of typescript-language-server',
    })
    expect(window.ostia.lsp.log).not.toHaveBeenCalled()
    await user.click(open)
    const dialog = await screen.findByRole('dialog')
    expect(window.ostia.lsp.log).toHaveBeenCalledWith('lsp-typescript/typescript')
    for (const line of [
      'Started (pid 4242)',
      'Initialized tsserver 5.3.0',
      'warming up',
      'Exited (code 1)',
      'Restarting in 500 ms (1/5)',
      'Stopping: no open files',
      'Exited (SIGTERM)',
      'Crashed too often; not restarting',
      'Stopping: turned off',
      'textDocument/hover',
    ]) {
      expect(await within(dialog).findByText(line)).toBeInTheDocument()
    }
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows where a fetched server’s program comes from and lets the human remove the copy', async () => {
    show([
      server({
        key: 'lsp-rust-analyzer/rust-analyzer',
        name: 'rust-analyzer',
        kind: 'download',
        program: 'rust-analyzer',
        version: '2026-09-28',
        status: 'running',
        folders: 1,
        binary: { source: 'managed', version: '2026-09-28' },
        managedCopy: true,
        fetchable: true,
      }),
      server({
        key: 'lsp-clangd/clangd',
        name: 'clangd',
        kind: 'download',
        program: 'clangd',
        version: '23.1.0',
        binary: { source: 'path' },
        fetchable: true,
      }),
    ])
    const user = userEvent.setup()
    const managed = await screen.findByRole('listitem', { name: 'rust-analyzer' })
    expect(within(managed).getByText('Download')).toBeInTheDocument()
    expect(
      within(managed).getByText('Using the copy Ostia keeps, version 2026-09-28.'),
    ).toBeInTheDocument()
    await user.click(
      within(managed).getByRole('button', {
        name: 'Remove the copy of rust-analyzer that Ostia keeps',
      }),
    )
    expect(window.ostia.lsp.removeDownload).toHaveBeenCalledWith('lsp-rust-analyzer/rust-analyzer')
    const onPath = screen.getByRole('listitem', { name: 'clangd' })
    expect(within(onPath).getByText('Using clangd from your PATH.')).toBeInTheDocument()
    expect(within(onPath).queryByRole('button', { name: /Remove the copy/ })).toBeNull()
    expect(within(onPath).queryByRole('button', { name: /Fetch clangd now/ })).toBeNull()
  })

  it('says a server will be downloaded on first use and fetches it now on request', async () => {
    show([
      server({
        key: 'lsp-lua/lua',
        name: 'lua-language-server',
        kind: 'download',
        program: 'lua-language-server',
        version: '3.19.1',
        fetchable: true,
      }),
    ])
    const user = userEvent.setup()
    expect(
      await screen.findByText(
        'Not on your PATH. Ostia downloads version 3.19.1 when a matching file opens.',
      ),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Fetch lua-language-server now' }))
    expect(window.ostia.lsp.fetch).toHaveBeenCalledWith('lsp-lua/lua')
  })

  it('shows download progress, and a failed fetch with its reason and Retry', async () => {
    show([
      server({
        key: 'a/down',
        name: 'downloading-server',
        kind: 'download',
        status: 'downloading',
        progress: 35,
      }),
      server({
        key: 'a/failed',
        name: 'failed-server',
        kind: 'download',
        status: 'download-failed',
        failure: 'http-error',
        failureDetail: '404',
        fetchable: true,
      }),
      server({
        key: 'lsp-gopls/gopls',
        name: 'gopls',
        kind: 'go-install',
        status: 'install-failed',
        failure: 'timeout',
        fetchable: true,
        fetchCommand: 'go install golang.org/x/tools/gopls@v0.23.0',
      }),
    ])
    const user = userEvent.setup()
    expect(await screen.findByText('Downloading… 35%')).toBeInTheDocument()
    const failed = screen.getByRole('listitem', { name: 'failed-server' })
    expect(within(failed).getByText('Download failed: the server answered 404')).toBeInTheDocument()
    await user.click(within(failed).getByRole('button', { name: 'Retry' }))
    expect(window.ostia.lsp.fetch).toHaveBeenCalledWith('a/failed')
    const gopls = screen.getByRole('listitem', { name: 'gopls' })
    expect(within(gopls).getByText('Install failed: it took too long')).toBeInTheDocument()
    expect(
      within(gopls).getByText(
        'Not on your PATH. Ostia runs go install golang.org/x/tools/gopls@v0.23.0 when a matching file opens.',
      ),
    ).toBeInTheDocument()
  })

  it('offers to install Go when go install has no toolchain to run', async () => {
    useWorkspacesStore.setState({ activeWorkspaceId: 'ws-1' })
    vi.mocked(window.ostia.system.requirements).mockResolvedValue({
      missing: [{ program: 'go', package: 'go' }],
      hint: { command: 'sudo pacman -S --needed go', packages: ['go'] },
      canInstall: true,
    })
    show([
      server({
        key: 'lsp-gopls/gopls',
        name: 'gopls',
        kind: 'go-install',
        status: 'toolchain-missing',
        requirement: 'lsp:lsp-gopls/gopls',
      }),
    ])
    expect(await screen.findByText('Go is not installed')).toBeInTheDocument()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Install gopls' }))
    expect(window.ostia.system.installRequirements).toHaveBeenCalledWith(
      'lsp:lsp-gopls/gopls',
      'ws-1',
    )
  })
  it('lets the human choose the program for a server and shows which one runs', async () => {
    show([server()])
    const user = userEvent.setup()
    const chosen = { path: '/opt/mine/tsls', args: ['--log', '--trace=off'] }
    vi.mocked(window.ostia.lsp.setOverride).mockResolvedValue({
      servers: [server({ override: chosen, binary: { source: 'override' } })],
    })
    await user.click(
      await screen.findByRole('button', {
        name: 'Choose the program for typescript-language-server',
      }),
    )
    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByLabelText('Program path'), ' /opt/mine/tsls ')
    await user.type(
      within(dialog).getByLabelText('Extra arguments, one per line'),
      '--log{Enter}{Enter}  --trace=off  ',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Use this program' }))
    expect(window.ostia.lsp.setOverride).toHaveBeenCalledWith('lsp-typescript/typescript', chosen)
    expect(
      await screen.findByText('Using /opt/mine/tsls, the program you chose.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the dialog open and says why when main refuses the program', async () => {
    show([server()])
    const user = userEvent.setup()
    vi.mocked(window.ostia.lsp.setOverride).mockResolvedValue({
      servers: [server()],
      problem: 'not-executable',
    })
    await user.click(
      await screen.findByRole('button', {
        name: 'Choose the program for typescript-language-server',
      }),
    )
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Use this program' })).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Program path'), '/etc/hostname')
    await user.click(within(dialog).getByRole('button', { name: 'Use this program' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The program you chose cannot be used: it is not executable',
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('shows a chosen program that stopped working and lets the human stop using it', async () => {
    const broken = server({
      status: 'override-invalid',
      override: { path: '/opt/gone/tsls', args: ['--log'], problem: 'missing' },
    })
    show([broken])
    const user = userEvent.setup()
    vi.mocked(window.ostia.lsp.setOverride).mockResolvedValue({ servers: [server()] })
    const row = await screen.findByRole('listitem', { name: 'typescript-language-server' })
    expect(within(row).getByTestId('language-server-status')).toHaveTextContent(
      'The program you chose cannot be used: nothing is at that path',
    )
    await user.click(
      within(row).getByRole('button', {
        name: 'Choose the program for typescript-language-server',
      }),
    )
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText('Program path')).toHaveValue('/opt/gone/tsls')
    expect(within(dialog).getByLabelText('Extra arguments, one per line')).toHaveValue('--log')
    await user.click(within(dialog).getByRole('button', { name: 'Stop using it' }))
    expect(window.ostia.lsp.setOverride).toHaveBeenCalledWith('lsp-typescript/typescript', null)
    expect(await within(row).findByText('Idle')).toBeInTheDocument()
  })
})
