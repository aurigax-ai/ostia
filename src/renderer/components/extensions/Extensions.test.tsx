import type {
  ExtensionInfo,
  ExtensionSidebarItem,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DeckRail } from '@/components/sidebar/DeckRail'
import { useUIStore } from '@/stores/app/uiStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'
import { renderSettled } from '../../../../test/render'
import { ExtensionApprovalDialog } from './ExtensionApprovalDialog'
import { ExtensionsPage } from './ExtensionSettingsPage'
import { ExtensionSidePanel } from './ExtensionSidePanel'
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
    connectionKinds: [],
    settingsPage: null,
    category: 'other',
    languages: [],
    languageServers: [],
    fileKinds: [],
    agentSkills: [],
    agentSkillProblems: [],
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
    it('lists each extension with an exception badge only where one applies and shows status and permissions in its details', async () => {
      useExtensionsStore.setState({
        list: [ext({ status: 'running', granted: ['notify'] }), pending],
      })
      await renderSettled(<ExtensionsSection />)
      const list = screen.getByRole('list', { name: 'Installed extensions' })
      expect(within(list).getByRole('listitem', { name: 'Demo' })).not.toHaveTextContent('Enabled')
      expect(
        within(within(list).getByRole('listitem', { name: 'Trellis' })).getByRole('button', {
          name: 'Approve…',
        }),
      ).toBeInTheDocument()
      expect(
        within(within(list).getByRole('listitem', { name: 'Demo' })).queryByRole('button', {
          name: 'Approve…',
        }),
      ).toBeNull()
      expect(screen.queryByRole('region', { name: 'Settings of Demo' })).toBeNull()

      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'Settings of Demo' }))
      const demo = screen.getByRole('region', { name: 'Settings of Demo' })
      expect(within(demo).getByText('Running')).toBeInTheDocument()
      expect(within(demo).getByText('notify')).toBeInTheDocument()
      expect(within(demo).getByText('Show notifications')).toBeInTheDocument()
      expect(within(demo).getByText('Approved')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Settings of Trellis' }))
      const trellis = screen.getByRole('region', { name: 'Settings of Trellis' })
      expect(within(trellis).getByText('Waiting for your approval')).toBeInTheDocument()
      expect(within(trellis).getByText('read-board')).toBeInTheDocument()
      expect(
        within(trellis).getByText('Read the workspaces and panes you have open'),
      ).toBeInTheDocument()
      expect(within(trellis).getAllByText('Requested')).toHaveLength(2)
      expect(screen.getByRole('region', { name: 'Settings of Demo' })).toBeInTheDocument()
    })

    it('keeps settings forms out of the list and shows each one’s form in its details', async () => {
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
      expect(screen.queryByRole('spinbutton')).toBeNull()

      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'Settings of Two' }))

      expect(screen.getByRole('spinbutton', { name: 'Second level' })).toBeInTheDocument()
      expect(screen.queryByRole('spinbutton', { name: 'First level' })).toBeNull()
    })

    it('opens the Browse dialog from the Browse button', async () => {
      useExtensionsStore.setState({ list: [ext({})] })
      await renderSettled(<ExtensionsPage anchor={null} />)
      await userEvent.setup().click(screen.getByRole('button', { name: 'Browse' }))
      expect(useUIStore.getState().settingsSection).toBe('extensions')
      expect(useUIStore.getState().browseExtensionsOpen).toBe(true)
    })

    it('omits the Settings group for a disabled assist extension', async () => {
      useExtensionsStore.setState({
        list: [
          ext({ id: 'assistant', name: 'Assistant', assist: ['chat'], enabled: false }),
          ext({ id: 'other', name: 'Other one' }),
        ],
      })
      await renderSettled(<ExtensionsSection />)
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'Settings of Assistant' }))
      await user.click(screen.getByRole('button', { name: 'Settings of Other one' }))
      const assistant = screen.getByRole('region', { name: 'Settings of Assistant' })
      expect(within(assistant).queryByRole('heading', { name: 'Settings' })).toBeNull()
      const other = screen.getByRole('region', { name: 'Settings of Other one' })
      expect(within(other).getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
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

    it('offers Approve… for any extension with unapproved caps, a built-in included', async () => {
      useExtensionsStore.setState({
        list: [
          ext({ unapproved: ['mcp'], requested: ['notify', 'mcp'], granted: ['notify'] }),
          ext({ ...pending, status: 'idle', enabled: true }),
        ],
      })
      await renderSettled(<ExtensionsSection />)
      const user = userEvent.setup()
      const [demoRow, trellisRow] = screen.getAllByRole('listitem', { name: /^(Demo|Trellis)$/ })
      await user.click(within(demoRow).getByRole('button', { name: 'Approve…' }))
      expect(useExtensionsStore.getState().reviewing).toBe('demo')
      await user.click(within(trellisRow).getByRole('button', { name: 'Approve…' }))
      expect(useExtensionsStore.getState().reviewing).toBe('trellis')
    })

    it('lists a widened file kind as waiting, in its own line and not among the capabilities', async () => {
      useExtensionsStore.setState({
        list: [
          ext({
            fileKinds: [
              {
                id: 'demo.grid',
                displayName: 'Grid',
                selector: [{ filenamePattern: '*.grid' }],
                view: { priority: 'default' },
                approved: false,
              },
            ],
          }),
        ],
      })
      await renderSettled(<ExtensionsSection />)
      const user = userEvent.setup()
      const row = screen.getByRole('listitem', { name: 'Demo' })
      expect(within(row).getByRole('button', { name: 'Approve…' })).toBeInTheDocument()
      await user.click(within(row).getByRole('button', { name: 'Settings of Demo' }))
      expect(within(row).getByText('Files not approved: Grid')).toBeInTheDocument()
      expect(within(row).queryByText(/^Not approved:/)).toBeNull()
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

    it('names the files, not a permission, and keeps the extension on when only a widened kind is under review', async () => {
      const setEnabled = vi.fn().mockResolvedValue([])
      window.ostia.extensions.setEnabled = setEnabled
      const widened = {
        ...ext({}),
        id: 'sheets',
        name: 'Sheets',
        enabled: true,
        status: 'idle' as const,
        requested: [],
        unapproved: [],
        fileKinds: [
          {
            id: 'sheets.grid',
            displayName: 'Grid',
            selector: [{ filenamePattern: '*.grid' }],
            view: { priority: 'default' as const },
            approved: false,
          },
        ],
      }
      useExtensionsStore.setState({ list: [widened], reviewing: 'sheets' })
      render(<ExtensionApprovalDialog />)

      const dialog = screen.getByRole('dialog')
      expect(within(dialog).getByText(/and to show the files listed below/)).toBeInTheDocument()
      expect(within(dialog).queryByText(/beyond its own commands and panel\.$/)).toBeNull()
      await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Keep them off' }))

      expect(setEnabled).not.toHaveBeenCalled()
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })

    it('shows nothing when no extension is waiting', () => {
      useExtensionsStore.setState({ list: [ext({})] })
      render(<ExtensionApprovalDialog />)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  describe('ExtensionSidePanel', () => {
    it('resolves the panel source and renders it in the extension partition', async () => {
      const panel = vi.fn().mockResolvedValue({ ok: true, src: 'http://127.0.0.1:4100/?t=abc' })
      window.ostia.extensions.panel = panel
      useExtensionsStore.setState({ list: [ext({})] })
      const { container } = render(
        <ExtensionSidePanel extId="demo" workspaceId="s1" focusKey="p1" />,
      )

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
      const { container } = render(
        <ExtensionSidePanel extId="demo" workspaceId="s1" focusKey="p1" />,
      )

      await userEvent.setup().click(await screen.findByRole('button', { name: 'Retry' }))

      await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
      expect(panel).toHaveBeenCalledTimes(2)
    })
  })

  describe('sidebar items', () => {
    it('renders per-workspace items on the workspace row and global ones in the footer', async () => {
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
      await renderSettled(<DeckRail />)
      act(() => useExtensionsStore.setState({ sidebar: items }))

      const row = (name: RegExp) =>
        screen.getByRole('button', { name }).closest('.rail-tab') as HTMLElement
      expect(within(row(/alpha/)).getByText('main*').closest('.ext-item')).toHaveClass('tone-warn')
      expect(within(row(/beta/)).queryByText('main*')).toBeNull()
      expect(document.querySelector('.rail-ext-footer')).toHaveTextContent(':3000')
    })
  })
})
