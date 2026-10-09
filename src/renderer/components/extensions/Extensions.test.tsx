import { commands } from '@/commands/registry'
import { DeckRail } from '@/components/rail/DeckRail'
import { useUIStore } from '@/stores/app/uiStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { type Workspace, useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { ExtensionInfo, ExtensionSidebarItem } from '@shared/extensions'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderSettled } from '../../../../test/render'
import { ExtensionApprovalDialog } from './ExtensionApprovalDialog'
import { ExtensionPanelView } from './ExtensionPanelView'
import { ExtensionsSection } from './InstalledExtensions'

function ext(overrides: Partial<ExtensionInfo>): ExtensionInfo {
  return {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    description: 'Board',
    builtin: true,
    enabled: true,
    status: 'idle',
    requested: [],
    granted: [],
    unapproved: [],
    commands: [],
    panel: { title: 'Board', icon: 'puzzle' },
    paneChips: [],
    workspaceChips: [],
    settings: [],
    settingValues: {},
    assist: [],
    secrets: [],
    secretsSet: [],
    settingsPage: null,
    category: 'other',
    languages: [],
    languageServers: [],
    agentSkills: [],
    agentHooks: [],
    iconThemes: [],
    keymaps: [],
    ...overrides,
  }
}

const pending = ext({
  id: 'trellis',
  name: 'Trellis',
  version: '0.3.0',
  description: 'Board for Trellis cards',
  builtin: false,
  enabled: false,
  status: 'pending-approval',
  requested: ['notify', 'read-board'],
  unapproved: ['notify', 'read-board'],
})

describe('Extensions UI', () => {
  let extInit: ReturnType<typeof useExtensionsStore.getState>
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>

  let uiInit: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    extInit = useExtensionsStore.getState()
    workspacesInit = useWorkspacesStore.getState()
    uiInit = useUIStore.getState()
  })

  afterEach(() => {
    cleanup()
    useExtensionsStore.setState(extInit, true)
    useWorkspacesStore.setState(workspacesInit, true)
    useUIStore.setState(uiInit, true)
  })

  describe('Settings → Extensions', () => {
    it('lists each extension with its state and shows the selected one’s status and permissions', async () => {
      useExtensionsStore.setState({
        list: [ext({ status: 'running', granted: ['notify'] }), pending],
      })
      await renderSettled(<ExtensionsSection />)
      const section = screen.getByRole('region', { name: 'Extensions' })
      const list = within(section).getByRole('list', { name: 'Installed extensions' })
      expect(within(list).getByRole('listitem', { name: 'Demo' })).toHaveTextContent('Enabled')
      expect(within(list).getByRole('listitem', { name: 'Trellis' })).toHaveTextContent(
        'Needs approval',
      )
      const demo = within(section).getByRole('region', { name: 'Demo' })
      expect(within(demo).getByText('Running')).toBeInTheDocument()
      expect(within(demo).getByRole('list', { name: 'Approved' })).toHaveTextContent(
        'notifyShow notifications',
      )

      await userEvent.setup().click(within(list).getByRole('button', { name: 'Trellis' }))

      const trellis = within(section).getByRole('region', { name: 'Trellis' })
      expect(within(trellis).getByText('Waiting for your approval')).toBeInTheDocument()
      expect(within(trellis).getByRole('list', { name: 'Requested' })).toHaveTextContent(
        'read-boardRead the workspaces and panes you have open',
      )
      expect(within(section).queryByRole('region', { name: 'Demo' })).toBeNull()
    })

    it('keeps settings forms out of the list and shows the selected one’s form in its details', async () => {
      const withSetting = (id: string, name: string, title: string): ExtensionInfo =>
        ext({
          id,
          name,
          settings: [{ key: 'level', type: 'number', title, default: 1, description: '' }],
          settingValues: { level: 1 },
        })
      useExtensionsStore.setState({
        list: [withSetting('one', 'One', 'First level'), withSetting('two', 'Two', 'Second level')],
      })
      await renderSettled(<ExtensionsSection />)
      const list = screen.getByRole('list', { name: 'Installed extensions' })
      expect(within(list).queryByRole('spinbutton')).toBeNull()
      expect(screen.getByRole('spinbutton', { name: 'First level' })).toBeInTheDocument()
      expect(screen.queryByRole('spinbutton', { name: 'Second level' })).toBeNull()

      await userEvent.setup().click(within(list).getByRole('button', { name: 'Two' }))

      expect(screen.getByRole('spinbutton', { name: 'Second level' })).toBeInTheDocument()
      expect(screen.queryByRole('spinbutton', { name: 'First level' })).toBeNull()
    })

    it('links to Browse extensions', async () => {
      useExtensionsStore.setState({ list: [ext({})] })
      await renderSettled(<ExtensionsSection />)
      await userEvent.setup().click(screen.getByRole('button', { name: 'Browse extensions' }))
      expect(useUIStore.getState().settingsSection).toBe('browseExtensions')
    })

    it('toggling an extension persists through the bridge', async () => {
      const setEnabled = vi.fn().mockResolvedValue([ext({ enabled: false, status: 'disabled' })])
      window.ostia.extensions.setEnabled = setEnabled
      useExtensionsStore.setState({ list: [ext({})] })
      await renderSettled(<ExtensionsSection />)

      await userEvent.setup().click(screen.getByRole('switch', { name: 'Enable Demo' }))

      expect(setEnabled).toHaveBeenCalledWith('demo', false)
      await waitFor(() => expect(useExtensionsStore.getState().list[0].status).toBe('disabled'))
    })

    it('offers a permission review for user extensions with unapproved caps only', async () => {
      useExtensionsStore.setState({
        list: [ext({ unapproved: ['notify'] }), ext({ ...pending, status: 'idle', enabled: true })],
      })
      await renderSettled(<ExtensionsSection />)
      const user = userEvent.setup()
      expect(screen.queryByRole('button', { name: 'Review permissions' })).toBeNull()
      expect(
        within(screen.getByRole('listitem', { name: 'Trellis' })).getByText('Problem'),
      ).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Trellis' }))
      await user.click(screen.getByRole('button', { name: 'Review permissions' }))
      expect(useExtensionsStore.getState().reviewing).toBe('trellis')
    })
  })

  describe('ExtensionApprovalDialog', () => {
    it('asks about a pending user extension, listing the caps it requests', () => {
      useExtensionsStore.setState({ list: [ext({}), pending] })
      render(<ExtensionApprovalDialog />)
      const dialog = screen.getByRole('dialog')
      expect(within(dialog).getByText('Allow the extension “Trellis”?')).toBeInTheDocument()
      const caps = within(dialog).getByRole('list', { name: 'Permissions' })
      expect(
        within(caps)
          .getAllByRole('listitem')
          .map((li) => li.textContent),
      ).toEqual(['notify', 'read-board'])
    })

    it('lists what each language server runs, for which files, and what the app would fetch', () => {
      const withServers = {
        ...pending,
        description: 'Without one, {product} downloads the pinned release.',
        requested: ['language-server' as const],
        languageServers: [
          { id: 'gleam', name: 'Gleam', languages: ['gleam'], command: 'gleam lsp' },
          { id: 'fmt', name: 'Fmt', languages: ['go', 'rust'], command: 'server/fmt.js --stdio' },
          {
            id: 'ra',
            name: 'rust-analyzer',
            languages: ['rust'],
            command: 'rust-analyzer',
            download: { program: 'rust-analyzer', version: '2026-09-28', host: 'github.com' },
          },
          {
            id: 'gopls',
            name: 'gopls',
            languages: ['go'],
            command: 'gopls',
            goInstall: { command: 'go install golang.org/x/tools/gopls@v0.23.0', binary: 'gopls' },
          },
        ],
      }
      useExtensionsStore.setState({ list: [withServers] })
      render(<ExtensionApprovalDialog />)
      expect(
        within(screen.getByRole('dialog')).getByText(
          'Without one, Ostia downloads the pinned release.',
        ),
      ).toBeInTheDocument()
      const servers = within(screen.getByRole('dialog')).getByRole('list', {
        name: 'Language servers',
      })
      expect(
        within(servers)
          .getAllByRole('listitem')
          .map((li) => li.textContent),
      ).toEqual([
        'Runs gleam lsp for gleam files',
        'Runs server/fmt.js --stdio for go, rust files',
        'Runs rust-analyzer for rust filesDownloads rust-analyzer 2026-09-28 from github.com when it is not on your PATH',
        'Runs gopls for go filesRuns go install golang.org/x/tools/gopls@v0.23.0 when gopls is not on your PATH',
      ])
    })

    it('lists the agent skills and hooks an extension adds and what a hook sees', () => {
      const kit = {
        ...pending,
        requested: ['agent-plugin' as const],
        commands: [
          {
            id: 'on-hook',
            title: 'Kit: record',
            palette: false,
            stdin: true,
            capabilities: [],
          },
        ],
        agentSkills: ['trellis-review'],
        agentHooks: [
          {
            event: 'SessionStart' as const,
            command: 'on-hook',
            agents: ['claude' as const, 'codex' as const],
          },
          { event: 'Notification' as const, command: 'on-hook', agents: ['claude' as const] },
        ],
      }
      useExtensionsStore.setState({ list: [kit] })
      render(<ExtensionApprovalDialog />)
      const section = within(screen.getByRole('dialog')).getByRole('region', {
        name: 'Adds to claude and codex in your terminals',
      })
      expect(within(section).getByText(/such as your prompt or a tool it runs/)).toBeInTheDocument()
      expect(within(section).getByText('Agent skills: trellis-review')).toBeInTheDocument()
      expect(
        within(section)
          .getAllByRole('listitem')
          .map((li) => li.textContent),
      ).toEqual([
        'Hook SessionStart runs “Kit: record” (claude, codex)',
        'Hook Notification runs “Kit: record” (claude)',
      ])
    })

    it('shows the agent skills and hooks on the Settings row too', async () => {
      useExtensionsStore.setState({
        list: [ext({ agentSkills: ['demo-review'], agentHooks: [] })],
      })
      await renderSettled(<ExtensionsSection />)
      expect(screen.getByText('Agent skills: demo-review')).toBeInTheDocument()
    })

    it('approving goes through the bridge and closes the dialog', async () => {
      const approved = {
        ...pending,
        enabled: true,
        status: 'idle' as const,
        granted: pending.requested,
      }
      const approve = vi.fn().mockResolvedValue([approved])
      window.ostia.extensions.approve = approve
      useExtensionsStore.setState({ list: [pending] })
      render(<ExtensionApprovalDialog />)

      await userEvent.setup().click(screen.getByRole('button', { name: 'Approve and enable' }))

      expect(approve).toHaveBeenCalledWith('trellis')
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })

    it('declining keeps the extension disabled and does not ask again this run', async () => {
      const setEnabled = vi.fn().mockResolvedValue([pending])
      window.ostia.extensions.setEnabled = setEnabled
      useExtensionsStore.setState({ list: [pending] })
      render(<ExtensionApprovalDialog />)

      await userEvent.setup().click(screen.getByRole('button', { name: 'Keep disabled' }))

      expect(setEnabled).toHaveBeenCalledWith('trellis', false)
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })

    it('shows nothing when no extension is waiting', () => {
      useExtensionsStore.setState({ list: [ext({})] })
      render(<ExtensionApprovalDialog />)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  describe('ExtensionPanelView', () => {
    it('resolves the panel source and renders it in the extension partition', async () => {
      const panel = vi.fn().mockResolvedValue({ ok: true, src: 'http://127.0.0.1:4100/?t=abc' })
      window.ostia.extensions.panel = panel
      useExtensionsStore.setState({ list: [ext({})] })
      const { container } = render(<ExtensionPanelView extId="demo" workspaceId="s1" paneId="p1" />)

      await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
      const webview = container.querySelector('webview') as HTMLElement
      expect(webview.getAttribute('src')).toBe('http://127.0.0.1:4100/?t=abc')
      expect(webview.getAttribute('partition')).toBe('ostia-ext-demo')
      expect(panel).toHaveBeenCalledWith('demo', { workspaceId: 's1', locale: 'en' })
    })

    it('shows the failure and retries on request', async () => {
      const panel = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, error: 'extension crashed' })
        .mockResolvedValueOnce({ ok: true, src: 'http://127.0.0.1:4100/' })
      window.ostia.extensions.panel = panel
      useExtensionsStore.setState({ list: [ext({})] })
      const { container } = render(<ExtensionPanelView extId="demo" workspaceId="s1" paneId="p1" />)

      await userEvent.setup().click(await screen.findByRole('button', { name: 'Retry' }))

      await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
      expect(panel).toHaveBeenCalledTimes(2)
    })

    it('renders no webview for a disabled or missing extension', async () => {
      const panel = vi.fn()
      window.ostia.extensions.panel = panel
      useExtensionsStore.setState({ list: [ext({ enabled: false, status: 'disabled' })] })
      const { container, rerender } = render(
        <ExtensionPanelView extId="demo" workspaceId="s1" paneId="p1" />,
      )
      expect(
        screen.getByText('Demo is disabled. Enable it in Settings → Extensions.'),
      ).toBeVisible()
      rerender(<ExtensionPanelView extId="gone" workspaceId="s1" paneId="p1" />)
      expect(screen.getByText('Extension “gone” is not installed.')).toBeVisible()
      expect(container.querySelector('webview')).toBeNull()
      expect(panel).not.toHaveBeenCalled()
    })

    it('says a restored pane’s extension no longer has a panel and offers to close it', async () => {
      const panel = vi.fn()
      window.ostia.extensions.panel = panel
      const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
      useExtensionsStore.setState({
        list: [ext({ id: 'assistant', name: 'Assistant', panel: null })],
      })
      render(<ExtensionPanelView extId="assistant" workspaceId="s1" paneId="p4" />)

      expect(screen.getByText('Assistant no longer has a panel.')).toBeVisible()
      await userEvent.setup().click(screen.getByRole('button', { name: 'Close pane' }))
      expect(exec).toHaveBeenCalledWith('pane.close', { paneId: 'p4' })
      expect(panel).not.toHaveBeenCalled()
      exec.mockRestore()
    })
  })

  describe('sidebar items', () => {
    it('renders per-workspace items on the workspace row and global ones in the footer', () => {
      const workspaces: Workspace[] = [
        { id: 's1', name: 'alpha', kind: 'terminal', workDir: '/a', state: 'idle' },
        { id: 's2', name: 'beta', kind: 'terminal', workDir: '/b', state: 'idle' },
      ]
      useWorkspacesStore.setState({ workspaces, activeWorkspaceId: 's1' })
      const items: ExtensionSidebarItem[] = [
        {
          extId: 'git',
          key: 'branch',
          workspaceId: 's1',
          text: 'main*',
          tone: 'warn',
          icon: 'git-branch',
          kind: 'location',
        },
        { extId: 'ports', key: 'default', text: ':3000', tone: 'ok', kind: 'live' },
      ]
      render(<DeckRail />)
      act(() => useExtensionsStore.setState({ sidebar: items }))

      const row = (name: RegExp) =>
        screen.getByRole('button', { name }).closest('.rail-tab') as HTMLElement
      expect(within(row(/alpha/)).getByText('main*').closest('.ext-item')).toHaveClass('tone-warn')
      expect(within(row(/beta/)).queryByText('main*')).toBeNull()
      expect(document.querySelector('.rail-ext-footer')).toHaveTextContent(':3000')
    })
  })
})
