import { commands } from '@/commands/registry'
import { chipsForPane, paneChipCatalog } from '@/lib/extensions/extensionChips'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { ExtensionInfo, ExtensionSettingResult, PaneChip } from '@shared/extensions'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderSettled } from '../../../../test/render'
import { PaneChips } from './ExtensionChips'
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
    status: 'running',
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

const chip = (overrides: Partial<PaneChip>): PaneChip => ({
  extId: 'vcs',
  id: 'branch',
  paneId: 'p1',
  text: 'main',
  tone: 'neutral',
  ...overrides,
})

const git = ext({
  id: 'vcs',
  name: 'Git',
  paneChips: [
    { id: 'branch', title: 'Branch' },
    { id: 'dirty', title: 'Changes' },
  ],
})
const env = ext({ id: 'env', name: 'Env', paneChips: [{ id: 'venv', title: 'Python env' }] })

describe('Extension API v2 UI', () => {
  let extInit: ReturnType<typeof useExtensionsStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    extInit = useExtensionsStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useExtensionsStore.setState(extInit, true)
    useSettingsStore.setState(settingsInit, true)
  })

  describe('pane chip catalog and selector', () => {
    it('lists the chips of enabled extensions in manifest order', () => {
      const catalog = paneChipCatalog([git, ext({ ...env, enabled: false })])
      expect(catalog).toEqual([
        { extId: 'vcs', extName: 'Git', id: 'branch', title: 'Branch' },
        { extId: 'vcs', extName: 'Git', id: 'dirty', title: 'Changes' },
      ])
    })

    it('returns one pane chips in catalog order with their titles', () => {
      const catalog = paneChipCatalog([env, git])
      const chips = [
        chip({ id: 'dirty', text: '+2' }),
        chip({ extId: 'env', id: 'venv', text: '.venv' }),
        chip({ text: 'main' }),
        chip({ paneId: 'p2', text: 'other' }),
        chip({ extId: 'gone', id: 'x', text: 'stale' }),
      ]
      expect(chipsForPane(chips, catalog, 'p1').map((c) => [c.title, c.text])).toEqual([
        ['Python env', '.venv'],
        ['Branch', 'main'],
        ['Changes', '+2'],
      ])
    })
  })

  describe('PaneChips in the pane header', () => {
    it('renders the pane chips as badges with their tone', () => {
      useExtensionsStore.setState({
        list: [git],
        chips: [chip({ tone: 'warn' }), chip({ paneId: 'p2', text: 'other' })],
      })
      render(<PaneChips paneId="p1" />)
      const list = screen.getByRole('list', { name: 'Extension status' })
      expect(list).toHaveTextContent('main')
      expect(list).not.toHaveTextContent('other')
      expect(screen.getByText('main')).toHaveClass('pane-chip', 'tone-warn')
      expect(screen.queryByRole('button')).toBeNull()
    })

    it('renders nothing for a pane without chips', () => {
      useExtensionsStore.setState({ list: [git], chips: [chip({ paneId: 'p2' })] })
      const { container } = render(<PaneChips paneId="p1" />)
      expect(container).toBeEmptyDOMElement()
    })

    it('runs the extension command of a chip after focusing its pane', async () => {
      const calls: string[] = []
      commands.register({
        id: 'pane.focus',
        title: 'Focus',
        run: (args: { paneId: string }) => {
          calls.push(`focus:${args.paneId}`)
        },
      })
      commands.register({ id: 'vcs.status', title: 'Status', run: () => calls.push('status') })
      useExtensionsStore.setState({ list: [git], chips: [chip({ command: 'status' })] })
      render(<PaneChips paneId="p1" />)
      await userEvent.setup().click(screen.getByRole('button', { name: /Branch: main/ }))
      await waitFor(() => expect(calls).toEqual(['focus:p1', 'status']))
      commands.unregister('pane.focus')
      commands.unregister('vcs.status')
    })

    it('opens the url of a link chip in the browser pane of that pane’s workspace', async () => {
      const openBrowser = vi.fn()
      const layoutInit = useLayoutStore.getState()
      const workspacesInit = useWorkspacesStore.getState()
      useLayoutStore.setState({
        byWorkspace: {
          s2: { root: { type: 'pane', id: 'p1', kind: 'terminal', title: 'zsh' } },
        },
        openBrowser,
      } as unknown as Partial<ReturnType<typeof useLayoutStore.getState>>)
      useExtensionsStore.setState({
        list: [git],
        chips: [chip({ text: ':3000', url: 'http://localhost:3000/' })],
      })
      render(<PaneChips paneId="p1" />)
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: /Branch: :3000.*http:\/\/localhost:3000\// }))
      expect(openBrowser).toHaveBeenCalledWith('s2', 'http://localhost:3000/', 'shared')
      expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('s2')
      useLayoutStore.setState(layoutInit, true)
      useWorkspacesStore.setState(workspacesInit, true)
    })

    it('updates when main pushes new chip values', () => {
      useExtensionsStore.setState({ list: [git], chips: [chip({})] })
      render(<PaneChips paneId="p1" />)
      act(() => useExtensionsStore.getState().setChips([chip({ text: 'dev' })]))
      expect(screen.getByText('dev')).toBeInTheDocument()
      expect(screen.queryByText('main')).toBeNull()
    })

    it('shows an icon chip with its count and lists its items to open or copy', async () => {
      const openBrowser = vi.fn()
      const layoutInit = useLayoutStore.getState()
      const workspacesInit = useWorkspacesStore.getState()
      useLayoutStore.setState({
        byWorkspace: {
          s2: { root: { type: 'pane', id: 'p1', kind: 'terminal', title: 'zsh' } },
        },
        openBrowser,
      } as unknown as Partial<ReturnType<typeof useLayoutStore.getState>>)
      useExtensionsStore.setState({
        list: [git],
        chips: [
          chip({
            text: '2',
            icon: 'plugs',
            items: [
              { text: ':3000', url: 'http://localhost:3000/' },
              { text: ':5173', url: 'http://localhost:5173/' },
            ],
          }),
        ],
      })
      const { container } = render(<PaneChips paneId="p1" />)
      const user = userEvent.setup()
      expect(screen.queryByText(':3000')).toBeNull()
      expect(container.querySelector('.pane-chip-dot')).not.toBeNull()
      expect(screen.queryByText('2')).toBeNull()

      await user.click(screen.getByRole('button', { name: 'Branch: 2. Click to list them.' }))
      const copy = await screen.findByRole('button', { name: 'Copy http://localhost:5173/' })
      await user.click(copy)
      expect(await navigator.clipboard.readText()).toBe('http://localhost:5173/')

      await user.click(
        screen.getByRole('button', { name: 'Open http://localhost:3000/ in the browser pane' }),
      )
      expect(openBrowser).toHaveBeenCalledWith('s2', 'http://localhost:3000/', 'shared')
      useLayoutStore.setState(layoutInit, true)
      useWorkspacesStore.setState(workspacesInit, true)
    })
  })

  describe('extension panel navigation', () => {
    it('navigates the shown panel to a new path without replacing its webview', async () => {
      const panel = vi.fn(async (_id: string, context: { path?: string }) => ({
        ok: true as const,
        src: `http://127.0.0.1:4100${context.path ?? '/'}`,
      }))
      window.ostia.extensions.panel = panel
      useExtensionsStore.setState({ list: [ext({})] })
      const { container } = render(<ExtensionPanelView extId="demo" workspaceId="s1" paneId="p1" />)
      await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
      const webview = container.querySelector('webview')

      act(() => useExtensionsStore.getState().navigatePanel('p1', '/cards/4'))

      await waitFor(() =>
        expect(webview?.getAttribute('src')).toBe('http://127.0.0.1:4100/cards/4'),
      )
      expect(container.querySelector('webview')).toBe(webview)
      expect(panel).toHaveBeenLastCalledWith('demo', {
        workspaceId: 's1',
        locale: 'en',
        path: '/cards/4',
      })
    })

    it('ignores a navigation meant for another pane', async () => {
      const panel = vi.fn().mockResolvedValue({ ok: true, src: 'http://127.0.0.1:4100/' })
      window.ostia.extensions.panel = panel
      useExtensionsStore.setState({ list: [ext({})] })
      const { container } = render(<ExtensionPanelView extId="demo" workspaceId="s1" paneId="p1" />)
      await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
      act(() => useExtensionsStore.getState().navigatePanel('p9', '/x'))
      expect(panel).toHaveBeenCalledTimes(1)
    })
  })

  describe('extension settings form', () => {
    const withSettings = ext({
      settings: [
        { key: 'loud', type: 'boolean', default: false, description: 'Shout it' },
        { key: 'count', type: 'number', default: 3, description: 'How many' },
        { key: 'greeting', type: 'string', default: 'hi', description: 'What it says' },
      ],
      settingValues: { loud: false, count: 3, greeting: 'hi' },
    })

    it('shows a control per setting with the effective value', async () => {
      useExtensionsStore.setState({ list: [withSettings] })
      await renderSettled(<ExtensionsSection />)
      expect(screen.getByRole('group', { name: 'Demo settings' })).toBeInTheDocument()
      expect(screen.getByText('Shout it')).toBeInTheDocument()
      expect(screen.getByRole('switch', { name: 'Loud' })).not.toBeChecked()
      expect(screen.getByRole('spinbutton', { name: 'Count' })).toHaveValue(3)
      expect(screen.getByRole('textbox', { name: 'Greeting' })).toHaveValue('hi')
    })

    it('saves through main and persists what main stored into settings.json', async () => {
      const updated = ext({
        ...withSettings,
        settingValues: { loud: true, count: 3, greeting: 'hi' },
      })
      const result: ExtensionSettingResult = { ok: true, stored: { loud: true }, list: [updated] }
      const setSetting = vi.fn().mockResolvedValue(result)
      window.ostia.extensions.setSetting = setSetting
      useExtensionsStore.setState({ list: [withSettings] })
      await renderSettled(<ExtensionsSection />)

      await userEvent.setup().click(screen.getByRole('switch', { name: 'Loud' }))

      expect(setSetting).toHaveBeenCalledWith('demo', 'loud', true)
      await waitFor(() => expect(screen.getByRole('switch', { name: 'Loud' })).toBeChecked())
      expect(useSettingsStore.getState().extensionSettings).toEqual({ demo: { loud: true } })
    })

    it('commits a number on Enter and shows a refusal from main', async () => {
      const setSetting = vi.fn().mockResolvedValue({ ok: false, error: 'invalid-value' })
      window.ostia.extensions.setSetting = setSetting
      useExtensionsStore.setState({ list: [withSettings] })
      await renderSettled(<ExtensionsSection />)
      const user = userEvent.setup()
      const input = screen.getByRole('spinbutton', { name: 'Count' })

      await user.clear(input)
      await user.type(input, '7{Enter}')

      expect(setSetting).toHaveBeenCalledWith('demo', 'count', 7)
      expect(await screen.findByRole('alert')).toHaveTextContent('Not saved: invalid-value')
      expect(useSettingsStore.getState().extensionSettings).toEqual({})
    })

    it('shows no form for an extension without settings', async () => {
      useExtensionsStore.setState({ list: [ext({})] })
      await renderSettled(<ExtensionsSection />)
      expect(screen.queryByRole('group', { name: 'Demo settings' })).toBeNull()
    })
  })
})
