import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPane } from '../layout/tree'
import * as blockActions from '../lib/blockActions'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { registerBuiltinCommands } from './builtins'
import { type CommandContext, commands } from './registry'

let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
let layoutInit: ReturnType<typeof useLayoutStore.getState>
let settingsInit: ReturnType<typeof useSettingsStore.getState>

beforeAll(() => {
  registerBuiltinCommands()
  workspacesInit = useWorkspacesStore.getState()
  layoutInit = useLayoutStore.getState()
  settingsInit = useSettingsStore.getState()
})

afterEach(() => {
  vi.restoreAllMocks()
  useWorkspacesStore.setState(workspacesInit, true)
  useLayoutStore.setState(layoutInit, true)
  useSettingsStore.setState(settingsInit, true)
})

const ctx = (activeWorkspaceId: string | null, activePaneId: string | null): CommandContext => ({
  activeWorkspaceId,
  activePaneId,
})

describe('builtins declare targets', () => {
  it('non-pane commands are target:none, pane commands stay target:active', () => {
    const byId = Object.fromEntries(commands.describe().map((c) => [c.id, c]))

    expect(byId['workspace.new'].target).toBe('none')
    expect(byId['palette.toggle'].target).toBe('none')
    expect(byId['view.toggleRail'].target).toBe('none')
    expect(byId['app.openSettings'].target).toBe('none')

    for (const id of [
      'pane.split',
      'pane.splitRight',
      'pane.splitDown',
      'pane.close',
      'pane.focus',
      'pane.move',
    ]) {
      expect(byId[id].target).toBe('active')
    }
  })
})

describe('builtins route to store actions', () => {
  it('routes pane.split to layout.split with an explicit paneId', async () => {
    const split = vi.spyOn(useLayoutStore.getState(), 'split').mockImplementation(() => {})

    await commands.execWith(ctx('s1', 'pA'), 'pane.split', {
      paneId: 'pX',
      direction: 'horizontal',
    })

    expect(split).toHaveBeenCalledWith('s1', 'pX', 'horizontal')
  })

  it('falls back to the active pane when pane.split gets no paneId', async () => {
    const split = vi.spyOn(useLayoutStore.getState(), 'split').mockImplementation(() => {})

    await commands.execWith(ctx('s1', 'pA'), 'pane.split', { direction: 'horizontal' })

    expect(split).toHaveBeenCalledWith('s1', 'pA', 'horizontal')
  })

  it('does not split when there is no active workspace', async () => {
    const split = vi.spyOn(useLayoutStore.getState(), 'split').mockImplementation(() => {})

    await commands.execWith(ctx(null, 'pA'), 'pane.split', {
      paneId: 'pX',
      direction: 'horizontal',
    })

    expect(split).not.toHaveBeenCalled()
  })

  it('routes pane.splitRight to layout.split with a horizontal direction', async () => {
    const split = vi.spyOn(useLayoutStore.getState(), 'split').mockImplementation(() => {})
    useWorkspacesStore.setState({ activeWorkspaceId: 's1' })
    useLayoutStore.setState({
      byWorkspace: { s1: { root: createPane('terminal'), activePaneId: 'pA', zoomedPaneId: null } },
    })

    await commands.exec('pane.splitRight')

    expect(split).toHaveBeenCalledWith('s1', 'pA', 'horizontal')
  })

  it('routes pane.splitDown to layout.split with a vertical direction', async () => {
    const split = vi.spyOn(useLayoutStore.getState(), 'split').mockImplementation(() => {})
    useWorkspacesStore.setState({ activeWorkspaceId: 's1' })
    useLayoutStore.setState({
      byWorkspace: { s1: { root: createPane('terminal'), activePaneId: 'pA', zoomedPaneId: null } },
    })

    await commands.exec('pane.splitDown')

    expect(split).toHaveBeenCalledWith('s1', 'pA', 'vertical')
  })

  it('pane.splitRight / pane.splitDown act on the caller ctx, not the active UI context', async () => {
    const split = vi.spyOn(useLayoutStore.getState(), 'split').mockImplementation(() => {})

    await commands.execWith(ctx('s9', 'p9'), 'pane.splitRight')
    await commands.execWith(ctx('s9', 'p9'), 'pane.splitDown')

    expect(split).toHaveBeenNthCalledWith(1, 's9', 'p9', 'horizontal')
    expect(split).toHaveBeenNthCalledWith(2, 's9', 'p9', 'vertical')
  })

  it('pane.splitRight propagates a failure from the inner pane.split', async () => {
    vi.spyOn(useLayoutStore.getState(), 'split').mockImplementation(() => {
      throw new Error('split exploded')
    })

    const r = await commands.execWith(ctx('s1', 'pA'), 'pane.splitRight')

    expect(r).toEqual({ ok: false, error: { code: 'command-failed', message: 'split exploded' } })
  })

  it('browser.open opens about:blank in the caller ctx workspace and propagates failures', async () => {
    const openBrowser = vi
      .spyOn(useLayoutStore.getState(), 'openBrowser')
      .mockImplementation(() => {})

    const ok = await commands.execWith(ctx('s7', null), 'browser.open')
    expect(ok.ok).toBe(true)
    expect(openBrowser).toHaveBeenCalledWith('s7', 'about:blank')

    openBrowser.mockImplementation(() => {
      throw new Error('no browser')
    })
    const failed = await commands.execWith(ctx('s7', null), 'browser.open')
    expect(failed).toEqual({ ok: false, error: { code: 'command-failed', message: 'no browser' } })
  })

  it('terminal.toggleInputEditor flips behavior.inputMode and needs settings-write', async () => {
    const described = commands.describe().find((c) => c.id === 'terminal.toggleInputEditor')
    expect(described?.capabilities).toEqual(['settings-write'])

    expect(await commands.exec('terminal.toggleInputEditor')).toEqual({
      ok: true,
      result: { inputMode: 'editor' },
    })
    expect(useSettingsStore.getState().behavior.inputMode).toBe('editor')
    await commands.exec('terminal.toggleInputEditor')
    expect(useSettingsStore.getState().behavior.inputMode).toBe('terminal')
  })

  it('settings.set reports a rejected path as a failed command', async () => {
    const r = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'init',
      value: 1,
    })

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toMatch(/unknown settings key: init/)
  })

  it('settings.set refuses to change the external editor command, directly or via behavior', async () => {
    const direct = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'behavior.externalEditor',
      value: '/tmp/evil {file}',
    })
    const nested = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'behavior',
      value: { ...useSettingsStore.getState().behavior, externalEditor: '/tmp/evil' },
    })
    const unrelated = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'behavior',
      value: { ...useSettingsStore.getState().behavior, cursorBlink: false },
    })

    expect(direct.ok).toBe(false)
    expect(nested.ok).toBe(false)
    expect(unrelated.ok).toBe(true)
    expect(useSettingsStore.getState().behavior.externalEditor).toBe('auto')
  })

  it('settings.set refuses to change the notification command, directly or via notifications', async () => {
    const direct = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'notifications.command',
      value: '/tmp/evil {title}',
    })
    const nested = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'notifications',
      value: { ...useSettingsStore.getState().notifications, command: '/tmp/evil' },
    })
    const unrelated = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'notifications',
      value: { ...useSettingsStore.getState().notifications, sound: false },
    })

    expect(direct.ok).toBe(false)
    expect(nested.ok).toBe(false)
    expect(unrelated.ok).toBe(true)
    expect(useSettingsStore.getState().notifications.command).toBe('')
  })

  it('zoom commands step the persisted zoom in 10 point increments within 80 to 150', async () => {
    const zoom = () => useSettingsStore.getState().appearance.zoom
    await commands.execWith(ctx(null, null), 'view.zoomIn')
    expect(zoom()).toBe(110)
    for (let i = 0; i < 10; i++) await commands.execWith(ctx(null, null), 'view.zoomIn')
    expect(zoom()).toBe(150)
    await commands.execWith(ctx(null, null), 'view.zoomReset')
    expect(zoom()).toBe(100)
    for (let i = 0; i < 10; i++) await commands.execWith(ctx(null, null), 'view.zoomOut')
    expect(zoom()).toBe(80)
  })

  it('routes pane.close to layout.closePane with an explicit paneId', async () => {
    const closePane = vi.spyOn(useLayoutStore.getState(), 'closePane').mockImplementation(() => {})

    await commands.execWith(ctx('s1', 'pA'), 'pane.close', { paneId: 'pX' })

    expect(closePane).toHaveBeenCalledWith('s1', 'pX')
  })

  it('falls back to the active pane when pane.close gets no paneId', async () => {
    const closePane = vi.spyOn(useLayoutStore.getState(), 'closePane').mockImplementation(() => {})

    await commands.execWith(ctx('s1', 'pA'), 'pane.close')

    expect(closePane).toHaveBeenCalledWith('s1', 'pA')
  })

  it('routes pane.focus to layout.focusPane', async () => {
    const focusPane = vi.spyOn(useLayoutStore.getState(), 'focusPane').mockImplementation(() => {})

    await commands.execWith(ctx('s1', 'pA'), 'pane.focus', { paneId: 'pX' })

    expect(focusPane).toHaveBeenCalledWith('s1', 'pX')
  })

  it('routes pane.move to layout.movePane with source, target, and zone', async () => {
    const movePane = vi.spyOn(useLayoutStore.getState(), 'movePane').mockImplementation(() => {})

    await commands.execWith(ctx('s1', 'pA'), 'pane.move', {
      sourceId: 'src',
      targetId: 'tgt',
      zone: 'right',
    })

    expect(movePane).toHaveBeenCalledWith('s1', 'src', 'tgt', 'right')
  })

  it('does not close a pane when there is no active workspace', async () => {
    const closePane = vi.spyOn(useLayoutStore.getState(), 'closePane').mockImplementation(() => {})

    await commands.execWith(ctx(null, 'pA'), 'pane.close', { paneId: 'pX' })

    expect(closePane).not.toHaveBeenCalled()
  })

  it('does not focus a pane when there is no active workspace', async () => {
    const focusPane = vi.spyOn(useLayoutStore.getState(), 'focusPane').mockImplementation(() => {})

    await commands.execWith(ctx(null, 'pA'), 'pane.focus', { paneId: 'pX' })

    expect(focusPane).not.toHaveBeenCalled()
  })

  it('does not move a pane when there is no active workspace', async () => {
    const movePane = vi.spyOn(useLayoutStore.getState(), 'movePane').mockImplementation(() => {})

    await commands.execWith(ctx(null, 'pA'), 'pane.move', {
      sourceId: 'src',
      targetId: 'tgt',
      zone: 'right',
    })

    expect(movePane).not.toHaveBeenCalled()
  })

  it('routes workspace.new to leaveSettings then addWorkspace, in that order', async () => {
    const leaveSettings = vi
      .spyOn(useUIStore.getState(), 'leaveSettings')
      .mockImplementation(() => {})
    const addWorkspace = vi
      .spyOn(useWorkspacesStore.getState(), 'addWorkspace')
      .mockImplementation(() => {})

    await commands.execWith(ctx(null, null), 'workspace.new')

    expect(leaveSettings).toHaveBeenCalled()
    expect(addWorkspace).toHaveBeenCalled()
    expect(leaveSettings.mock.invocationCallOrder[0]).toBeLessThan(
      addWorkspace.mock.invocationCallOrder[0],
    )
  })

  it('routes palette.toggle to ui.togglePalette', async () => {
    const togglePalette = vi
      .spyOn(useUIStore.getState(), 'togglePalette')
      .mockImplementation(() => {})

    await commands.execWith(ctx(null, null), 'palette.toggle')

    expect(togglePalette).toHaveBeenCalled()
  })

  it('routes view.toggleRail to ui.toggleRail', async () => {
    const toggleRail = vi.spyOn(useUIStore.getState(), 'toggleRail').mockImplementation(() => {})

    await commands.execWith(ctx(null, null), 'view.toggleRail')

    expect(toggleRail).toHaveBeenCalled()
  })

  it('routes app.openSettings to ui.openSettings', async () => {
    const openSettings = vi
      .spyOn(useUIStore.getState(), 'openSettings')
      .mockImplementation(() => {})

    await commands.execWith(ctx(null, null), 'app.openSettings')

    expect(openSettings).toHaveBeenCalled()
  })
})

describe('pane.list / workspace.list', () => {
  it('pane.list defaults to the active workspace only, reporting kind/title/cwd per pane', async () => {
    const paneS1 = createPane('terminal', 'zsh', '/work/api')
    const paneS2 = createPane('editor', 'untitled', '/work/web')
    useWorkspacesStore.setState({
      workspaces: [
        { id: 's1', name: 'api', kind: 'terminal', workDir: '/work/api', state: 'idle' },
        { id: 's2', name: 'web', kind: 'terminal', workDir: '/work/web', state: 'idle' },
      ],
    })
    useLayoutStore.setState({
      byWorkspace: {
        s1: { root: paneS1, activePaneId: paneS1.id, zoomedPaneId: null },
        s2: { root: paneS2, activePaneId: paneS2.id, zoomedPaneId: null },
      },
    })

    const res = await commands.execWith(ctx('s1', null), 'pane.list')

    expect(res).toEqual({
      ok: true,
      result: [
        { paneId: paneS1.id, workspaceId: 's1', kind: 'terminal', title: 'zsh', cwd: '/work/api' },
      ],
    })
  })

  it("pane.list with allWorkspaces walks every workspace's layout tree", async () => {
    const paneS1 = createPane('terminal', 'zsh', '/work/api')
    const paneS2 = createPane('editor', 'untitled', '/work/web')
    useWorkspacesStore.setState({
      workspaces: [
        { id: 's1', name: 'api', kind: 'terminal', workDir: '/work/api', state: 'idle' },
        { id: 's2', name: 'web', kind: 'terminal', workDir: '/work/web', state: 'idle' },
      ],
    })
    useLayoutStore.setState({
      byWorkspace: {
        s1: { root: paneS1, activePaneId: paneS1.id, zoomedPaneId: null },
        s2: { root: paneS2, activePaneId: paneS2.id, zoomedPaneId: null },
      },
    })

    const res = await commands.execWith(ctx('s1', null), 'pane.list', { allWorkspaces: true })

    expect(res).toEqual({
      ok: true,
      result: [
        { paneId: paneS1.id, workspaceId: 's1', kind: 'terminal', title: 'zsh', cwd: '/work/api' },
        {
          paneId: paneS2.id,
          workspaceId: 's2',
          kind: 'editor',
          title: 'untitled',
          cwd: '/work/web',
        },
      ],
    })
  })

  it('pane.list returns an empty array when there is no active workspace and allWorkspaces is unset', async () => {
    const res = await commands.execWith(ctx(null, null), 'pane.list')
    expect(res).toEqual({ ok: true, result: [] })
  })

  it('workspace.list reports every workspace regardless of ctx', async () => {
    useWorkspacesStore.setState({
      workspaces: [
        { id: 's1', name: 'api', kind: 'terminal', workDir: '/work/api', state: 'idle' },
        { id: 's2', name: 'web', kind: 'agent', workDir: '/work/web', state: 'working' },
      ],
    })

    const res = await commands.execWith(ctx(null, null), 'workspace.list')

    expect(res).toEqual({
      ok: true,
      result: [
        { workspaceId: 's1', name: 'api', kind: 'terminal', workDir: '/work/api', state: 'idle' },
        { workspaceId: 's2', name: 'web', kind: 'agent', workDir: '/work/web', state: 'working' },
      ],
    })
  })

  it('pane.list and workspace.list are hidden, target:none, and gated on read-board', () => {
    const byId = Object.fromEntries(commands.describe().map((c) => [c.id, c]))
    for (const id of ['pane.list', 'workspace.list']) {
      expect(byId[id].hidden).toBe(true)
      expect(byId[id].target).toBe('none')
      expect(byId[id].capabilities).toEqual(['read-board'])
    }
  })
})

describe('builtins with zero workspaces', () => {
  it('gives commands a context with no workspace and no pane', async () => {
    expect(await commands.exec('pane.list', { allWorkspaces: true })).toEqual({
      ok: true,
      result: [],
    })
    expect(await commands.exec('pane.list')).toEqual({ ok: true, result: [] })
    expect(await commands.exec('workspace.list')).toEqual({ ok: true, result: [] })
  })

  it('runs pane commands as no-ops instead of throwing or creating a workspace', async () => {
    for (const id of [
      'pane.splitRight',
      'pane.splitDown',
      'pane.close',
      'pane.zoom',
      'browser.open',
    ]) {
      expect(await commands.exec(id)).toEqual({ ok: true, result: undefined })
    }
    expect(await commands.exec('block.selectNext')).toEqual({ ok: true, result: { blockId: null } })
    expect(await commands.exec('history.insert', { command: 'ls' })).toEqual({
      ok: true,
      result: { inserted: false },
    })
    expect(useWorkspacesStore.getState().workspaces).toEqual([])
    expect(useLayoutStore.getState().byWorkspace).toEqual({})
  })

  it('opens an empty workspace at home with workspace.new', async () => {
    const res = await commands.exec('workspace.new')

    expect(res.ok).toBe(true)
    const [only] = useWorkspacesStore.getState().workspaces
    expect(only).toMatchObject({ workDir: '~', name: 'home' })
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe(only.id)
    expect(useLayoutStore.getState().byWorkspace[only.id]).toBeUndefined()
  })
})

describe('agent resume', () => {
  function seedPane(resume?: { agent: 'claude' | 'codex'; id: string }) {
    const pane = { ...createPane('terminal'), ...(resume ? { resume } : {}) }
    useLayoutStore.setState({
      byWorkspace: { s1: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
    })
    return pane
  }

  it('stores the resume token on the calling pane', async () => {
    const pane = seedPane()
    await commands.execWith(ctx('s1', pane.id), 'resume.set', { agent: 'claude', id: 'abc' })
    expect(useLayoutStore.getState().byWorkspace.s1.root).toMatchObject({
      resume: { agent: 'claude', id: 'abc' },
    })
  })

  it('runs the agent’s resume command in the pane', async () => {
    const pane = seedPane({ agent: 'claude', id: 'abc' })
    const insert = vi.spyOn(blockActions, 'insertCommand').mockReturnValue(true)
    const r = await commands.execWith(ctx('s1', pane.id), 'agent.resume')
    expect(insert).toHaveBeenCalledWith(pane.id, 'claude --resume abc', true)
    expect(r).toMatchObject({ ok: true, result: { resumed: true } })
  })

  it('does nothing for a pane without a token', async () => {
    const pane = seedPane()
    const insert = vi.spyOn(blockActions, 'insertCommand')
    const r = await commands.execWith(ctx('s1', pane.id), 'agent.resume')
    expect(insert).not.toHaveBeenCalled()
    expect(r).toMatchObject({ ok: true, result: { resumed: false } })
  })
})

describe('workspace row commands', () => {
  const seed = () =>
    useWorkspacesStore.setState({
      workspaces: [
        { id: 'w1', name: 'api', kind: 'terminal', workDir: '/a', state: 'idle' },
        { id: 'w2', name: 'web', kind: 'terminal', workDir: '/b', state: 'idle' },
      ],
      activeWorkspaceId: 'w1',
    })

  it('describes the caller’s own workspace', async () => {
    seed()
    await commands.execWith(ctx('w2', 'p'), 'workspace.describe', { text: 'PR #7' })
    expect(useWorkspacesStore.getState().workspaces[1].description).toBe('PR #7')
    expect(useWorkspacesStore.getState().workspaces[0].description).toBeUndefined()
  })

  it('jumps to a workspace by position and reports a missing one', async () => {
    seed()
    const r = await commands.execWith(ctx(null, null), 'workspace.goto', { index: 1 })
    expect(r).toMatchObject({ ok: true, result: { switched: true } })
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('w2')
    const miss = await commands.execWith(ctx(null, null), 'workspace.goto', { index: 5 })
    expect(miss).toMatchObject({ ok: true, result: { switched: false } })
  })

  it('pins the active workspace from the palette', async () => {
    seed()
    await commands.execWith(ctx('w2', null), 'workspace.togglePin')
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(['w2', 'w1'])
    expect(useWorkspacesStore.getState().workspaces[0].pinned).toBe(true)
  })
})

describe('agent notifications', () => {
  function seedPane() {
    const pane = { ...createPane('terminal'), title: 'claude' }
    useLayoutStore.setState({
      byWorkspace: { s1: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
    })
    return pane
  }

  function viewWorkspace() {
    useWorkspacesStore.setState({ activeWorkspaceId: 's1' })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  }

  afterEach(() => vi.mocked(window.pine.notifications.post).mockClear())

  it('posts a desktop banner when an agent waits in a pane you are not looking at', async () => {
    const pane = seedPane()
    await commands.execWith(ctx('s1', pane.id), 'attention.set', {
      state: 'waiting',
      message: 'Allow Bash?',
    })
    expect(window.pine.notifications.post).toHaveBeenCalledWith({
      paneId: pane.id,
      title: 'Agent needs your input',
      body: 'Allow Bash?',
      desktop: true,
    })
  })

  it('records a finished agent under the pane title without a banner when agentDone is off', async () => {
    const pane = seedPane()
    useSettingsStore.getState().setNotifications({ agentDone: false })
    await commands.execWith(ctx('s1', pane.id), 'attention.set', { state: 'done' })
    expect(window.pine.notifications.post).toHaveBeenCalledWith({
      paneId: pane.id,
      title: 'Agent finished',
      body: 'claude',
      desktop: false,
    })
  })

  it('posts nothing for a working state', async () => {
    const pane = seedPane()
    await commands.execWith(ctx('s1', pane.id), 'attention.set', { state: 'working' })
    expect(window.pine.notifications.post).not.toHaveBeenCalled()
  })

  it('tells pine notify to skip the banner for the pane being viewed unless whenFocused is on', async () => {
    const pane = seedPane()
    viewWorkspace()
    const viewed = await commands.execWith(ctx('s1', pane.id), 'attention.notify', {
      message: 'hi',
    })
    expect(viewed).toMatchObject({ ok: true, result: { desktop: false } })

    useSettingsStore.getState().setNotifications({ whenFocused: true })
    const focused = await commands.execWith(ctx('s1', pane.id), 'attention.notify', {
      message: 'hi',
    })
    expect(focused).toMatchObject({ ok: true, result: { desktop: true } })
  })
})
