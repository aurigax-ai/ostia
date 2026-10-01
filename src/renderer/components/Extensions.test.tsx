import type { ExtensionInfo, ExtensionSidebarItem } from '@shared/extensions'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { commands } from '../commands/registry'
import { useExtensionsStore } from '../stores/extensionsStore'
import { type Workspace, useWorkspacesStore } from '../stores/workspacesStore'
import { DeckRail } from './DeckRail'
import { ExtensionApprovalDialog } from './ExtensionApprovalDialog'
import { ExtensionPanelView } from './ExtensionPanelView'
import { ExtensionsSection } from './SettingsPanel'

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
    category: 'other',
    languages: [],
    iconThemes: [],
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

  beforeAll(() => {
    extInit = useExtensionsStore.getState()
    workspacesInit = useWorkspacesStore.getState()
  })

  afterEach(() => {
    cleanup()
    useExtensionsStore.setState(extInit, true)
    useWorkspacesStore.setState(workspacesInit, true)
  })

  describe('Settings → Extensions', () => {
    it('lists each extension with its status and granted permissions', () => {
      useExtensionsStore.setState({
        list: [ext({ status: 'running', granted: ['notify'] }), pending],
      })
      render(<ExtensionsSection />)
      const section = screen.getByRole('region', { name: 'Extensions' })
      expect(within(section).getByText('Demo')).toBeInTheDocument()
      expect(within(section).getByText(/Running · Permissions: notify/)).toBeInTheDocument()
      expect(within(section).getByText(/Waiting for your approval/)).toBeInTheDocument()
    })

    it('toggling an extension persists through the bridge', async () => {
      const setEnabled = vi.fn().mockResolvedValue([ext({ enabled: false, status: 'disabled' })])
      window.pine.extensions.setEnabled = setEnabled
      useExtensionsStore.setState({ list: [ext({})] })
      render(<ExtensionsSection />)

      await userEvent.setup().click(screen.getByRole('switch', { name: 'Enable Demo' }))

      expect(setEnabled).toHaveBeenCalledWith('demo', false)
      await waitFor(() => expect(useExtensionsStore.getState().list[0].status).toBe('disabled'))
    })

    it('offers a permission review for user extensions with unapproved caps only', async () => {
      useExtensionsStore.setState({
        list: [ext({ unapproved: ['notify'] }), ext({ ...pending, status: 'idle', enabled: true })],
      })
      render(<ExtensionsSection />)
      const reviews = screen.getAllByRole('button', { name: 'Review permissions' })
      expect(reviews).toHaveLength(1)
      await userEvent.setup().click(reviews[0])
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

    it('approving goes through the bridge and closes the dialog', async () => {
      const approved = {
        ...pending,
        enabled: true,
        status: 'idle' as const,
        granted: pending.requested,
      }
      const approve = vi.fn().mockResolvedValue([approved])
      window.pine.extensions.approve = approve
      useExtensionsStore.setState({ list: [pending] })
      render(<ExtensionApprovalDialog />)

      await userEvent.setup().click(screen.getByRole('button', { name: 'Approve and enable' }))

      expect(approve).toHaveBeenCalledWith('trellis')
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })

    it('declining keeps the extension disabled and does not ask again this run', async () => {
      const setEnabled = vi.fn().mockResolvedValue([pending])
      window.pine.extensions.setEnabled = setEnabled
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
      window.pine.extensions.panel = panel
      useExtensionsStore.setState({ list: [ext({})] })
      const { container } = render(<ExtensionPanelView extId="demo" workspaceId="s1" paneId="p1" />)

      await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
      const webview = container.querySelector('webview') as HTMLElement
      expect(webview.getAttribute('src')).toBe('http://127.0.0.1:4100/?t=abc')
      expect(webview.getAttribute('partition')).toBe('pine-ext-demo')
      expect(panel).toHaveBeenCalledWith('demo', { workspaceId: 's1', locale: 'en' })
    })

    it('shows the failure and retries on request', async () => {
      const panel = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, error: 'extension crashed' })
        .mockResolvedValueOnce({ ok: true, src: 'http://127.0.0.1:4100/' })
      window.pine.extensions.panel = panel
      useExtensionsStore.setState({ list: [ext({})] })
      const { container } = render(<ExtensionPanelView extId="demo" workspaceId="s1" paneId="p1" />)

      await userEvent.setup().click(await screen.findByRole('button', { name: 'Retry' }))

      await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
      expect(panel).toHaveBeenCalledTimes(2)
    })

    it('renders no webview for a disabled or missing extension', async () => {
      const panel = vi.fn()
      window.pine.extensions.panel = panel
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
      window.pine.extensions.panel = panel
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
