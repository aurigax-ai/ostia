import type { ExtensionInfo, ExtensionSettingsStored, PaneChip } from '@shared/extensions'
import type { Terminal } from '@xterm/xterm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { findPane, isPaneShown, paneIds, resetIds, tabsOfPane } from '../layout/tree'
import { registerOffscreenStarter } from '../lib/offscreenStart'
import { isTitlePinned, resetPinnedTitles } from '../lib/pinnedTitles'
import { registerTerminal } from '../lib/terminalHandles'
import { useBlocksStore } from '../stores/blocksStore'
import { useDiffStore } from '../stores/diffStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import {
  openExtensionDiff,
  openExtensionPanel,
  openExtensionTerminal,
  syncExtensionCommands,
  wireExtensionBridge,
} from './extensionBridge'
import { commands } from './registry'

function ext(overrides: Partial<ExtensionInfo> = {}): ExtensionInfo {
  return {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    description: '',
    builtin: true,
    enabled: true,
    status: 'idle',
    requested: [],
    granted: [],
    unapproved: [],
    commands: [
      {
        id: 'open',
        title: 'Open Board',
        category: 'App',
        palette: true,
        stdin: false,
        capabilities: ['read-board'],
      },
      { id: 'add', title: 'Add', palette: false, stdin: false, capabilities: ['notify'] },
    ],
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

describe('extensionBridge', () => {
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let extInit: ReturnType<typeof useExtensionsStore.getState>

  beforeAll(() => {
    layoutInit = useLayoutStore.getState()
    workspacesInit = useWorkspacesStore.getState()
    extInit = useExtensionsStore.getState()
  })

  afterEach(() => {
    syncExtensionCommands([])
    useLayoutStore.setState(layoutInit, true)
    useWorkspacesStore.setState(workspacesInit, true)
    useExtensionsStore.setState(extInit, true)
    useDiffStore.setState({ byPane: {} })
    resetIds()
  })

  it('registers palette commands of enabled extensions under <extId>.<command>', () => {
    syncExtensionCommands([ext()])
    const cmd = commands.describe().find((c) => c.id === 'demo.open')
    expect(cmd).toMatchObject({
      title: 'Open Board',
      category: 'App',
      capabilities: ['read-board'],
    })
    expect(commands.has('demo.add')).toBe(false)
  })

  it('removes the commands when the extension is disabled, and notifies subscribers', () => {
    const listener = vi.fn()
    const unsubscribe = commands.subscribe(listener)
    syncExtensionCommands([ext()])
    syncExtensionCommands([ext({ enabled: false })])
    unsubscribe()
    expect(commands.has('demo.open')).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('never shadows a core command with the same id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const core = vi.fn()
    commands.register({ id: 'pane.split', title: 'Split Pane', run: core })
    syncExtensionCommands([
      ext({
        id: 'pane',
        commands: [{ id: 'split', title: 'Hijack', palette: true, stdin: false, capabilities: [] }],
      }),
    ])
    expect(commands.list().find((c) => c.id === 'pane.split')?.title).toBe('Split Pane')
    expect(warn).toHaveBeenCalledTimes(1)
    syncExtensionCommands([])
    expect(commands.has('pane.split')).toBe(true)
    commands.unregister('pane.split')
    warn.mockRestore()
  })

  it('running a command invokes the extension with the active workspace and pane', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, data: { opened: true } })
    window.ostia.extensions.invoke = invoke
    syncExtensionCommands([ext()])
    const res = await commands.execWith(
      { activeWorkspaceId: 's1', activePaneId: 'pane-1' },
      'demo.open',
    )
    expect(invoke).toHaveBeenCalledWith(
      'demo',
      'open',
      { workspaceId: 's1', paneId: 'pane-1' },
      undefined,
    )
    expect(res).toEqual({ ok: true, result: { opened: true } })
  })

  it('passes the typed argument only to a command that declares one', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true })
    window.ostia.extensions.invoke = invoke
    const base = ext().commands[0]
    syncExtensionCommands([
      ext({
        commands: [
          { ...base, id: 'card', title: 'Open Card', argument: 'Card id' },
          { ...base, id: 'open' },
        ],
      }),
    ])
    expect(commands.list().find((c) => c.id === 'demo.card')?.argument).toBe('Card id')
    const ctx = { activeWorkspaceId: 's1', activePaneId: null }
    await commands.execWith(ctx, 'demo.card', { argument: 'SHOP-12' })
    await commands.execWith(ctx, 'demo.open', { argument: 'ignored' })
    expect(invoke.mock.calls.map((c) => c[3])).toEqual(['SHOP-12', undefined])
  })

  it('surfaces an extension failure as a failed command', async () => {
    window.ostia.extensions.invoke = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'extension-unavailable', message: 'crashed' })
    syncExtensionCommands([ext()])
    const res = await commands.execWith(
      { activeWorkspaceId: 's1', activePaneId: null },
      'demo.open',
    )
    expect(res).toEqual({
      ok: false,
      error: { code: 'command-failed', message: 'extension-unavailable: crashed' },
    })
  })

  it('openExtensionPanel opens one panel pane per extension in the requested workspace', () => {
    useWorkspacesStore.setState({
      workspaces: [{ id: 's1', name: 'a', kind: 'terminal', workDir: '/a', state: 'idle' }],
      activeWorkspaceId: 's1',
    })
    useLayoutStore.getState().ensure('s1')
    useExtensionsStore.setState({ list: [ext()] })

    openExtensionPanel({ extId: 'demo', workspaceId: 's1' })
    openExtensionPanel({ extId: 'demo', workspaceId: 'unknown-workspace' })
    openExtensionPanel({ extId: 'ghost' })

    const root = useLayoutStore.getState().byWorkspace.s1.root
    const panels = paneIds(root)
      .map((id) => findPane(root, id))
      .filter((p) => p?.kind === 'extension')
    expect(panels).toHaveLength(1)
    expect(panels[0]).toMatchObject({ extensionId: 'demo', title: 'Board' })
  })

  it('openExtensionPanel with a path navigates the open panel instead of adding a second', () => {
    useWorkspacesStore.setState({
      workspaces: [{ id: 's1', name: 'a', kind: 'terminal', workDir: '/a', state: 'idle' }],
      activeWorkspaceId: 's1',
    })
    useLayoutStore.getState().ensure('s1')
    useExtensionsStore.setState({ list: [ext()] })

    const first = openExtensionPanel({ extId: 'demo', workspaceId: 's1' })
    expect(useExtensionsStore.getState().panelNav).toEqual({})
    const second = openExtensionPanel({ extId: 'demo', workspaceId: 's1', path: '/cards/3' })
    const third = openExtensionPanel({ extId: 'demo', path: '/cards/3' })

    expect(second).toBe(first)
    expect(third).toBe(first)
    const root = useLayoutStore.getState().byWorkspace.s1.root
    expect(paneIds(root).filter((id) => findPane(root, id)?.kind === 'extension')).toEqual([first])
    const nav = useExtensionsStore.getState().panelNav[first as string]
    expect(nav.path).toBe('/cards/3')
    expect(useLayoutStore.getState().byWorkspace.s1.activePaneId).toBe(first)
  })

  it('forwards pane chip updates from main into the store', () => {
    const sink: { push?: (chips: PaneChip[]) => void } = {}
    window.ostia.extensions.onPaneChips = vi.fn((cb) => {
      sink.push = cb
      return () => {}
    })
    wireExtensionBridge()
    const chip: PaneChip = { extId: 'demo', id: 'c', paneId: 'p1', text: 'x', tone: 'ok' }
    sink.push?.([chip])
    expect(useExtensionsStore.getState().chips).toEqual([chip])
  })

  it('persists settings an extension changed for itself into the settings store', () => {
    const settingsInit = useSettingsStore.getState()
    const sink: { push?: (update: ExtensionSettingsStored) => void } = {}
    window.ostia.extensions.onSettingsStored = vi.fn((cb) => {
      sink.push = cb
      return () => {}
    })
    try {
      wireExtensionBridge()
      sink.push?.({ extId: 'git', stored: { changesView: 'tree' } })
      expect(useSettingsStore.getState().extensionSettings.git).toEqual({ changesView: 'tree' })
    } finally {
      useSettingsStore.setState(settingsInit, true)
    }
  })

  it('openExtensionDiff opens one reusable diff pane and stores its content by pane id', () => {
    useWorkspacesStore.setState({
      workspaces: [{ id: 's1', name: 'a', kind: 'terminal', workDir: '/a', state: 'idle' }],
      activeWorkspaceId: 's1',
    })
    useLayoutStore.getState().ensure('s1')
    const first = openExtensionDiff({
      extId: 'vcs',
      workspaceId: 's1',
      title: 'a.ts',
      original: 'x',
      modified: 'y',
      path: '/repo/src/a.ts',
    })
    const second = openExtensionDiff({
      extId: 'vcs',
      workspaceId: 'gone',
      title: 'b.ts',
      original: '1',
      modified: '2',
    })

    expect(second).toBe(first)
    const layout = useLayoutStore.getState().byWorkspace.s1
    const diffs = paneIds(layout.root)
      .map((id) => findPane(layout.root, id))
      .filter((p) => p?.kind === 'diff')
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toMatchObject({ id: first, title: 'b.ts' })
    expect(layout.activePaneId).toBe(first)
    expect(useDiffStore.getState().byPane[first as string]).toEqual({
      title: 'b.ts',
      original: '1',
      modified: '2',
    })
  })

  it('points the diff pane cwd at the file directory so repo lookups follow it', () => {
    useWorkspacesStore.setState({
      workspaces: [{ id: 's1', name: 'a', kind: 'terminal', workDir: '/a', state: 'idle' }],
      activeWorkspaceId: 's1',
    })
    useLayoutStore.getState().ensure('s1')
    const id = openExtensionDiff({
      extId: 'vcs',
      title: 'a.ts',
      original: '',
      modified: '',
      path: '/repo/src/a.ts',
    })
    const root = useLayoutStore.getState().byWorkspace.s1.root
    expect(findPane(root, id as string)?.cwd).toBe('/repo/src')
  })

  it('opens no panel or diff and creates no workspace when there are no workspaces', () => {
    useExtensionsStore.setState({ list: [ext()] })

    openExtensionPanel({ extId: 'demo' })
    const diff = openExtensionDiff({ extId: 'vcs', title: 'a.ts', original: '', modified: '' })

    expect(diff).toBeNull()
    expect(useWorkspacesStore.getState().workspaces).toEqual([])
    expect(useLayoutStore.getState().byWorkspace).toEqual({})
  })

  describe('openExtensionTerminal', () => {
    let blocksInit: ReturnType<typeof useBlocksStore.getState>

    beforeAll(() => {
      blocksInit = useBlocksStore.getState()
    })

    afterEach(() => {
      useBlocksStore.setState(blocksInit, true)
      resetPinnedTitles()
    })

    function twoWorkspaces(): void {
      useWorkspacesStore.setState({
        workspaces: [
          { id: 's1', name: 'a', kind: 'terminal', workDir: '/a', state: 'idle' },
          { id: 's2', name: 'b', kind: 'terminal', workDir: '/b', state: 'idle' },
        ],
        activeWorkspaceId: 's2',
      })
    }

    it('splits right of the agent pane, shows its workspace, and runs the command at the first idle prompt', () => {
      twoWorkspaces()
      useLayoutStore.getState().ensure('s1')
      const agent = useLayoutStore.getState().byWorkspace.s1.activePaneId
      useLayoutStore.getState().split('s1', agent, 'vertical')

      const paneId = openExtensionTerminal({
        requestId: 'r1',
        workspaceId: 's1',
        afterPaneId: agent,
        command: 'sudo pacman -S --needed ripgrep',
        cwd: '/a/project',
        title: 'Install packages',
      })

      expect(paneId).not.toBeNull()
      const layout = useLayoutStore.getState().byWorkspace.s1
      expect(layout.activePaneId).toBe(paneId)
      expect(findPane(layout.root, paneId as string)).toMatchObject({
        kind: 'terminal',
        cwd: '/a/project',
        title: 'Install packages',
      })
      const parent = layout.root.type === 'split' ? layout.root.children[0] : null
      expect(parent).toMatchObject({ type: 'split', direction: 'horizontal' })
      expect(paneIds(parent as never)).toEqual([agent, paneId])
      expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('s1')

      const paste = vi.fn()
      const unregister = registerTerminal(
        paneId as string,
        {
          paste,
          focus: vi.fn(),
        } as unknown as Terminal,
      )
      const blocks = useBlocksStore.getState()
      blocks.promptStart(paneId as string, { line: 0 }, '/a/project')
      expect(paste).not.toHaveBeenCalled()
      blocks.promptEnd(paneId as string, { line: 0 })
      expect(paste).toHaveBeenCalledWith('sudo pacman -S --needed ripgrep')
      expect(window.ostia.pty.write).toHaveBeenCalledWith(paneId, '\r')
      unregister()
    })

    it('opens a background tab beside the caller without taking the focus or the workspace', () => {
      twoWorkspaces()
      useLayoutStore.getState().ensure('s1')
      const agent = useLayoutStore.getState().byWorkspace.s1.activePaneId
      useLayoutStore.getState().split('s1', agent, 'horizontal')
      const focused = useLayoutStore.getState().byWorkspace.s1.activePaneId
      expect(focused).not.toBe(agent)

      const paneId = openExtensionTerminal({
        requestId: 'r5',
        workspaceId: 's1',
        afterPaneId: agent,
        command: `claude 'fix the "login" bug'`,
        title: 'worker',
        backgroundTab: true,
        pinTitle: true,
      }) as string

      const layout = useLayoutStore.getState().byWorkspace.s1
      expect(layout.activePaneId).toBe(focused)
      expect(tabsOfPane(layout.root, agent)).toMatchObject({ activeId: agent })
      expect(tabsOfPane(layout.root, agent)?.children.map((p) => p.id)).toEqual([agent, paneId])
      expect(findPane(layout.root, paneId)).toMatchObject({ kind: 'terminal', title: 'worker' })
      expect(isPaneShown(layout.root, paneId)).toBe(false)
      expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('s2')
      expect(isTitlePinned(paneId)).toBe(true)
      expect(isTitlePinned(agent)).toBe(false)

      const paste = vi.fn()
      const unregister = registerTerminal(paneId, { paste, focus: vi.fn() } as unknown as Terminal)
      const blocks = useBlocksStore.getState()
      blocks.promptStart(paneId, { line: 0 }, '/a')
      blocks.promptEnd(paneId, { line: 0 })
      expect(paste).toHaveBeenCalledWith(`claude 'fix the "login" bug'`)
      expect(window.ostia.pty.write).toHaveBeenCalledWith(paneId, '\r')
      unregister()
    })

    it('starts the shell of a terminal opened in a workspace nobody has looked at', () => {
      twoWorkspaces()
      const paneId = openExtensionTerminal({
        requestId: 'r6',
        workspaceId: 's1',
        command: 'claude',
        backgroundTab: true,
      }) as string
      expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('s2')

      const start = vi.fn()
      const unregister = registerOffscreenStarter(paneId, start)
      expect(start).toHaveBeenCalledTimes(1)
      unregister()
    })

    it('makes the terminal the first pane of an empty workspace', () => {
      twoWorkspaces()
      const paneId = openExtensionTerminal({ requestId: 'r2', workspaceId: 's2', command: 'ls' })
      const layout = useLayoutStore.getState().byWorkspace.s2
      expect(layout.root).toMatchObject({ type: 'pane', id: paneId, kind: 'terminal' })
    })

    it('opens nothing for a workspace that does not exist or when there is none', () => {
      twoWorkspaces()
      expect(openExtensionTerminal({ requestId: 'r3', workspaceId: 'gone', command: 'ls' })).toBe(
        null,
      )
      useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null })
      expect(openExtensionTerminal({ requestId: 'r4', command: 'ls' })).toBeNull()
      expect(useLayoutStore.getState().byWorkspace).toEqual({})
    })
  })
})
