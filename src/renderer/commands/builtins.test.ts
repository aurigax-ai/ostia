import { Terminal } from '@xterm/xterm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPane, splitOf, tabsOf } from '../layout/tree'
import * as blockActions from '../lib/blockActions'
import { registerBrowserHandle } from '../lib/browserHandles'
import * as closeConfirm from '../lib/closeConfirm'
import { registerTerminal } from '../lib/terminalHandles'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import { useCloseConfirmStore } from '../stores/closeConfirmStore'
import { useEditorStatus } from '../stores/editorStatusStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSandboxStore } from '../stores/sandboxStore'
import { useSettingsStore } from '../stores/settingsStore'
import * as surfaceSlots from '../stores/surfaceSlotsStore'
import { useUIStore } from '../stores/uiStore'
import { useUpdateStore } from '../stores/updateStore'
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

  describe('browser profile of a new browser pane', () => {
    const openBrowserSpy = () =>
      vi.spyOn(useLayoutStore.getState(), 'openBrowser').mockImplementation(() => {})
    const workspaces = (kind: 'terminal' | 'scratch') =>
      useWorkspacesStore.setState({
        workspaces: [{ id: 's7', name: 'a', kind, workDir: '/a', state: 'idle' }],
        activeWorkspaceId: 's7',
      })

    afterEach(() => useSandboxStore.setState({ enabled: {} }))

    it('gives the human the shared profile', async () => {
      workspaces('terminal')
      const openBrowser = openBrowserSpy()
      await commands.execWith(ctx('s7', null), 'browser.new', { url: 'http://a.test/' })
      expect(openBrowser).toHaveBeenCalledWith('s7', 'http://a.test/', 'shared')
    })

    it('keeps a pane opened over the control socket isolated, whatever the args say', async () => {
      workspaces('terminal')
      const openBrowser = openBrowserSpy()
      const remote: CommandContext = { ...ctx('s7', null), origin: 'remote' }
      await commands.execWith(remote, 'browser.new', { url: 'http://a.test/', profile: 'shared' })
      await commands.execWith(remote, 'browser.open')
      expect(openBrowser).toHaveBeenNthCalledWith(1, 's7', 'http://a.test/', 'isolated')
      expect(openBrowser).toHaveBeenNthCalledWith(2, 's7', 'about:blank', 'isolated')
    })

    it('keeps the human’s pane isolated in a scratch workspace', async () => {
      workspaces('scratch')
      const openBrowser = openBrowserSpy()
      await commands.execWith(ctx('s7', null), 'browser.new')
      expect(openBrowser).toHaveBeenCalledWith('s7', 'about:blank', 'isolated')
    })

    it('keeps the human’s pane isolated in a sandboxed workspace', async () => {
      workspaces('terminal')
      useSandboxStore.setState({ enabled: { s7: true } })
      const openBrowser = openBrowserSpy()
      await commands.execWith(ctx('s7', null), 'browser.new')
      expect(openBrowser).toHaveBeenCalledWith('s7', 'about:blank', 'isolated')
    })

    it('gives a new browser tab the opener’s profile', async () => {
      workspaces('terminal')
      const newTab = vi.spyOn(useLayoutStore.getState(), 'newTab').mockImplementation(() => null)
      await commands.execWith(ctx('s7', 'p1'), 'tab.newBrowser')
      await commands.execWith({ ...ctx('s7', 'p1'), origin: 'remote' }, 'tab.newBrowser')
      expect(newTab).toHaveBeenNthCalledWith(1, 's7', 'p1', 'browser', 'shared')
      expect(newTab).toHaveBeenNthCalledWith(2, 's7', 'p1', 'browser', 'isolated')
    })
  })

  it('browser.open opens about:blank in the caller ctx workspace and propagates failures', async () => {
    const openBrowser = vi
      .spyOn(useLayoutStore.getState(), 'openBrowser')
      .mockImplementation(() => {})

    const ok = await commands.execWith(ctx('s7', null), 'browser.open')
    expect(ok.ok).toBe(true)
    expect(openBrowser).toHaveBeenCalledWith('s7', 'about:blank', 'shared')

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

  it('terminal.clear clears the caller’s terminal, redraws the prompt only when idle, and needs shell', async () => {
    const described = commands.describe().find((c) => c.id === 'terminal.clear')
    expect(described?.capabilities).toEqual(['shell'])
    const term = new Terminal({ cols: 20, rows: 4 })
    const unregister = registerTerminal('pT', term)
    const sent: string[] = []
    term.onData((d) => sent.push(d))
    try {
      await new Promise<void>((r) => term.write('one\r\n$ ', r))
      expect(await commands.execWith(ctx('s1', 'pT'), 'terminal.clear')).toEqual({
        ok: true,
        result: { cleared: true },
      })
      expect(term.buffer.active.baseY).toBe(2)
      expect(sent).toEqual(['\x0c'])

      useBlocksStore.setState({ running: { pT: 'b1' } })
      await commands.execWith(ctx('s1', 'pT'), 'terminal.clear')
      expect(sent).toEqual(['\x0c'])
    } finally {
      unregister()
      term.dispose()
      useBlocksStore.setState({ running: {} })
    }
    expect(await commands.execWith(ctx('s1', 'pT'), 'terminal.clear')).toEqual({
      ok: true,
      result: { cleared: false },
    })
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

  it('settings.set refuses to turn on agent auto-resume, directly or via agents', async () => {
    const direct = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'agents.autoResume',
      value: true,
    })
    const nested = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'agents',
      value: { ...useSettingsStore.getState().agents, autoResume: true },
    })
    expect(direct.ok).toBe(false)
    expect(nested.ok).toBe(false)
    expect(useSettingsStore.getState().agents.autoResume).toBe(false)
  })

  it('settings.set and settings.unset refuse secret redaction, whole or by key', async () => {
    const off = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'privacy.redaction.enabled',
      value: false,
    })
    const pattern = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'privacy.redaction.patterns',
      value: ['.+'],
    })
    const whole = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'privacy',
      value: { redaction: { enabled: false, patterns: [] } },
    })
    const unset = await commands.execWith(ctx(null, null), 'settings.unset', {
      key: 'privacy.redaction.enabled',
    })
    for (const res of [off, pattern, whole, unset]) {
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error.message).toBe('privacy can only be changed by you in Settings')
    }
    expect(useSettingsStore.getState().privacy.redaction).toEqual({ enabled: true, patterns: [] })
  })

  it('settings.set picks a text editing preset, refuses unknown ones, and unset goes back to null', async () => {
    const exec = (id: string, args: unknown) => commands.execWith(ctx(null, null), id, args)
    expect(await exec('settings.set', { key: 'terminalKeymap', value: 'none' })).toEqual({
      ok: true,
      result: { previous: null, value: 'none', applied: true },
    })
    expect(await exec('settings.get', { key: 'terminalKeymap' })).toEqual({
      ok: true,
      result: 'none',
    })
    const bad = await exec('settings.set', { key: 'terminalKeymap', value: 'vim' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.message).toMatch(/terminalKeymap must be null or one of/)
    expect(await exec('settings.unset', { key: 'terminalKeymap' })).toEqual({
      ok: true,
      result: { previous: 'none', value: null },
    })
  })

  it('settings.set and settings.unset refuse terminal keys, so an agent cannot bind a key that types for the human', async () => {
    useSettingsStore.setState({ terminalKeys: { 'Cmd+Left': null } })
    const exec = (id: string, args: unknown) => commands.execWith(ctx(null, null), id, args)
    const attempts = [
      await exec('settings.set', {
        key: 'terminalKeys.Cmd+Left',
        value: { type: 'text', value: 'y\\r' },
      }),
      await exec('settings.set', {
        key: 'terminalKeys',
        value: { 'Cmd+K': { type: 'text', value: 'rm -rf ~\\r' } },
      }),
      await exec('settings.unset', { key: 'terminalKeys' }),
    ]
    for (const res of attempts) {
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error.message).toBe('terminalKeys can only be changed by you in Settings')
      }
    }
    expect(useSettingsStore.getState().terminalKeys).toEqual({ 'Cmd+Left': null })
    expect(await exec('settings.get', { key: 'terminalKeys' })).toEqual({
      ok: true,
      result: { 'Cmd+Left': null },
    })
  })

  it('settings.set and settings.unset refuse the multi-line paste confirmation, directly or via terminal', async () => {
    const direct = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'terminal.warnOnRiskyPaste',
      value: false,
    })
    const nested = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'terminal',
      value: { ...useSettingsStore.getState().terminal, warnOnRiskyPaste: false },
    })
    const unset = await commands.execWith(ctx(null, null), 'settings.unset', {
      key: 'terminal.warnOnRiskyPaste',
    })
    const unrelated = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'terminal',
      value: { ...useSettingsStore.getState().terminal, scrollSpeed: 2 },
    })
    expect(direct.ok).toBe(false)
    if (!direct.ok) expect(direct.error.message).toMatch(/terminal.warnOnRiskyPaste/)
    expect(nested.ok).toBe(false)
    expect(unset.ok).toBe(false)
    expect(unrelated.ok).toBe(true)
    expect(useSettingsStore.getState().terminal.warnOnRiskyPaste).toBe(true)
  })

  it('settings.set refuses OSC 52 clipboard writes and the global hotkey', async () => {
    const osc = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'terminal.osc52Write',
      value: true,
    })
    const hotkey = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'workspaces',
      value: { ...useSettingsStore.getState().workspaces, globalHotkey: 'Ctrl+Alt+Space' },
    })
    expect(osc.ok).toBe(false)
    expect(hotkey.ok).toBe(false)
    expect(useSettingsStore.getState().terminal.osc52Write).toBe(false)
    expect(useSettingsStore.getState().workspaces.globalHotkey).toBe('')
  })

  it('settings.set refuses the agent hook switches, directly or via agents', async () => {
    const direct = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'agents.hooks.claude',
      value: false,
    })
    const nested = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'agents',
      value: { ...useSettingsStore.getState().agents, hooks: { claude: true, codex: false } },
    })
    expect(direct.ok).toBe(false)
    expect(nested.ok).toBe(false)
    expect(useSettingsStore.getState().agents.hooks).toEqual({ claude: true, codex: true })
  })

  it('settings.set refuses the shell program, directly or via terminal', async () => {
    const direct = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'terminal.shell',
      value: '/tmp/evil',
    })
    const nested = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'terminal',
      value: { ...useSettingsStore.getState().terminal, shell: '/tmp/evil' },
    })
    expect(direct.ok).toBe(false)
    if (!direct.ok) expect(direct.error.message).toMatch(/terminal.shell/)
    expect(nested.ok).toBe(false)
    expect(useSettingsStore.getState().terminal.shell).toBe('')
  })

  it('settings.set and settings.unset refuse the automatic update check, directly or via behavior', async () => {
    const direct = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'behavior.checkForUpdates',
      value: false,
    })
    const nested = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'behavior',
      value: { ...useSettingsStore.getState().behavior, checkForUpdates: false },
    })
    const unset = await commands.execWith(ctx(null, null), 'settings.unset', {
      key: 'behavior.checkForUpdates',
    })
    expect(direct.ok).toBe(false)
    if (!direct.ok) expect(direct.error.message).toMatch(/behavior.checkForUpdates/)
    expect(nested.ok).toBe(false)
    expect(unset.ok).toBe(false)
    expect(useSettingsStore.getState().behavior.checkForUpdates).toBe(true)
  })

  it('app.checkForUpdates opens Settings on About and asks main to check', async () => {
    const updateInit = useUpdateStore.getState()
    const openSettings = vi
      .spyOn(useUIStore.getState(), 'openSettings')
      .mockImplementation(() => {})

    const r = await commands.execWith(ctx(null, null), 'app.checkForUpdates', {})

    expect(r.ok).toBe(true)
    expect(openSettings).toHaveBeenCalledWith('about')
    expect(window.ostia.update.checkRelease).toHaveBeenCalledTimes(1)
    await vi.waitFor(() =>
      expect(useUpdateStore.getState().releaseCheck).toEqual({
        status: 'latest',
        version: '0.0.0',
      }),
    )
    useUpdateStore.setState(updateInit, true)
  })

  it('settings.set --dry-run validates without applying, and reports the previous value', async () => {
    const dry = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'editor.tabSize',
      value: 4,
      dryRun: true,
    })
    expect(dry).toEqual({ ok: true, result: { previous: 2, value: 4, applied: false } })
    expect(useSettingsStore.getState().editor.tabSize).toBe(2)

    const bad = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'editor.tabSize',
      value: 3,
      dryRun: true,
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.message).toMatch(/invalid value for editor.tabSize/)
  })

  it('settings.unset puts a key back to its default and settings.get reads every section', async () => {
    await commands.execWith(ctx(null, null), 'settings.set', { key: 'editor.tabSize', value: 8 })
    const unset = await commands.execWith(ctx(null, null), 'settings.unset', {
      key: 'editor.tabSize',
    })
    expect(unset).toEqual({ ok: true, result: { previous: 8, value: 2 } })
    const got = await commands.execWith(ctx(null, null), 'settings.get', { key: 'editor.tabSize' })
    expect(got).toEqual({ ok: true, result: 2 })
  })

  it('settings.schema describes one key or refuses an unknown one', async () => {
    const one = await commands.execWith(ctx(null, null), 'settings.schema', {
      key: 'editor.openFilesIn',
    })
    expect(one).toMatchObject({ ok: true, result: { type: 'string', enum: ['tab', 'split'] } })
    const unknown = await commands.execWith(ctx(null, null), 'settings.schema', { key: 'nope' })
    expect(unknown.ok).toBe(false)
  })

  it('settings.set changes a keybinding by its dotted command id and settings.get reads it back', async () => {
    const set = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'keybindings.palette.toggle',
      value: 'Ctrl+Shift+Y',
    })
    const got = await commands.execWith(ctx(null, null), 'settings.get', {
      key: 'keybindings.palette.toggle',
    })
    expect(set.ok).toBe(true)
    expect(got).toEqual({ ok: true, result: 'Ctrl+Shift+Y' })
  })

  it('settings.set refuses a keybinding that would steal a terminal key', async () => {
    const r = await commands.execWith(ctx(null, null), 'settings.set', {
      key: 'keybindings.palette.toggle',
      value: 'Ctrl+R',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toMatch(/keybindings.palette.toggle: "Ctrl\+R"/)
    expect(useSettingsStore.getState().keybindings).toEqual({})
  })

  it('settings.set picks a keymap by "<extension>/<keymap>", refuses anything else, and unset goes back to null', async () => {
    const exec = (id: string, args: unknown) => commands.execWith(ctx(null, null), id, args)
    expect(await exec('settings.set', { key: 'keymap', value: 'ostia', dryRun: true })).toEqual({
      ok: true,
      result: { previous: null, value: 'ostia', applied: false },
    })
    expect(
      await exec('settings.set', { key: 'keymap', value: 'keymap-macos/cmux', dryRun: true }),
    ).toEqual({ ok: true, result: { previous: null, value: 'keymap-macos/cmux', applied: false } })
    expect(useSettingsStore.getState().keymap).toBeNull()
    expect(await exec('settings.set', { key: 'keymap', value: 'keymap-macos/cmux' })).toEqual({
      ok: true,
      result: { previous: null, value: 'keymap-macos/cmux', applied: true },
    })
    expect(await exec('settings.get', { key: 'keymap' })).toEqual({
      ok: true,
      result: 'keymap-macos/cmux',
    })
    for (const value of ['cmux', 'Keymap/cmux', 3, {}]) {
      const bad = await exec('settings.set', { key: 'keymap', value })
      expect(bad.ok, String(value)).toBe(false)
      if (!bad.ok) expect(bad.error.message).toMatch(/keymap must be null, /)
    }
    expect(useSettingsStore.getState().keymap).toBe('keymap-macos/cmux')
    expect(await exec('settings.unset', { key: 'keymap' })).toEqual({
      ok: true,
      result: { previous: 'keymap-macos/cmux', value: null },
    })
    expect(useSettingsStore.getState().keymap).toBeNull()
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

  it('asks the human before closing a pane but closes at once for an agent on the socket', async () => {
    const ask = vi.spyOn(closeConfirm, 'requestClosePane').mockResolvedValue()
    const closePane = vi.spyOn(useLayoutStore.getState(), 'closePane').mockImplementation(() => {})

    await commands.execWith(ctx('s1', 'pA'), 'pane.close', { paneId: 'pX' })
    expect(ask).toHaveBeenCalledWith('s1', 'pX')
    expect(closePane).not.toHaveBeenCalled()

    ask.mockClear()
    const fromSocket = { ...ctx('s1', 'pA'), target: { workspaceId: 's1', paneId: 'pA' } }
    await commands.execWith(fromSocket, 'pane.close', { paneId: 'pX' })
    expect(ask).not.toHaveBeenCalled()
    expect(closePane).toHaveBeenCalledWith('s1', 'pX')
  })

  it('still asks the human when an agent closes a pane holding unsaved changes', async () => {
    const ask = vi.spyOn(useCloseConfirmStore.getState(), 'ask').mockResolvedValue(false)
    const editor = { ...createPane('editor'), filePath: '/w/notes.md' }
    useWorkspacesStore.setState({
      workspaces: [{ id: 's1', name: 'w', kind: 'terminal', workDir: '/w', state: 'idle' }],
    })
    useLayoutStore.setState({
      byWorkspace: { s1: { root: editor, activePaneId: editor.id, zoomedPaneId: null } },
    })
    useEditorStatus.setState({ dirty: { '/w/notes.md': true } })
    const fromSocket = { ...ctx('s1', editor.id), target: { workspaceId: 's1', paneId: editor.id } }

    await commands.execWith(fromSocket, 'pane.close')

    expect(ask).toHaveBeenCalledWith('pane', [
      expect.objectContaining({ workspaceId: 's1', files: ['/w/notes.md'] }),
    ])
    expect(useLayoutStore.getState().byWorkspace.s1.root).toBe(editor)
    useEditorStatus.setState({ dirty: {} })
  })

  it('refuses an agent closing a locked pane, and never lets the socket lock or unlock one', async () => {
    const kept = { ...createPane('terminal'), locked: true as const }
    useLayoutStore.setState({
      byWorkspace: { s1: { root: kept, activePaneId: kept.id, zoomedPaneId: null } },
    })
    const fromSocket = { ...ctx('s1', kept.id), target: { workspaceId: 's1', paneId: kept.id } }

    const refused = await commands.execWith(fromSocket, 'pane.close', { paneId: kept.id })

    expect(refused).toMatchObject({ ok: false, error: { code: 'command-failed' } })
    expect(refused.ok ? '' : refused.error.message).toContain('pane-locked')
    expect(useLayoutStore.getState().byWorkspace.s1.root).toBe(kept)
    expect(commands.isLocal('pane.toggleLock')).toBe(true)
  })

  it('toggles the lock of the target pane for the human', async () => {
    const pane = createPane('terminal')
    useLayoutStore.setState({
      byWorkspace: { s1: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
    })

    await commands.execWith(ctx('s1', pane.id), 'pane.toggleLock')
    expect(useLayoutStore.getState().isLocked('s1', pane.id)).toBe(true)
    await commands.execWith(ctx('s1', pane.id), 'pane.close')
    expect(useLayoutStore.getState().byWorkspace.s1.root).toMatchObject({ id: pane.id })

    await commands.execWith(ctx('s1', pane.id), 'pane.toggleLock')
    expect(useLayoutStore.getState().isLocked('s1', pane.id)).toBe(false)
  })

  it('routes pane.focus to layout.focusPane', async () => {
    const focusPane = vi.spyOn(useLayoutStore.getState(), 'focusPane').mockImplementation(() => {})

    await commands.execWith(ctx('s1', 'pA'), 'pane.focus', { paneId: 'pX' })

    expect(focusPane).toHaveBeenCalledWith('s1', 'pX')
  })

  it('moves focus to the pane beside the caller’s pane, and not while a pane is zoomed', async () => {
    const left = createPane()
    const right = createPane()
    useLayoutStore.setState({
      byWorkspace: {
        s1: {
          root: {
            type: 'split',
            id: 'sp',
            direction: 'horizontal',
            children: [left, right],
            sizes: [1, 1],
          },
          activePaneId: left.id,
          zoomedPaneId: null,
        },
      },
    })
    await commands.execWith(ctx('s1', left.id), 'pane.focusRight')
    expect(useLayoutStore.getState().byWorkspace.s1.activePaneId).toBe(right.id)
    await commands.execWith(ctx('s1', right.id), 'pane.focusRight')
    expect(useLayoutStore.getState().byWorkspace.s1.activePaneId).toBe(right.id)
    useLayoutStore.getState().zoomPane('s1', right.id, true)
    await commands.execWith(ctx('s1', right.id), 'pane.focusLeft')
    expect(useLayoutStore.getState().byWorkspace.s1.activePaneId).toBe(right.id)
  })

  it('cycles the tabs of the caller’s pane with tab.next and tab.previous', async () => {
    const a = createPane()
    const b = createPane()
    const c = createPane()
    useLayoutStore.setState({
      byWorkspace: { s1: { root: tabsOf(a.id, a, b, c), activePaneId: a.id, zoomedPaneId: null } },
    })
    const shown = () => {
      const { root, activePaneId } = useLayoutStore.getState().byWorkspace.s1
      return [activePaneId, root.type === 'tabs' ? root.activeId : null]
    }
    await commands.execWith(ctx('s1', a.id), 'tab.next')
    expect(shown()).toEqual([b.id, b.id])
    await commands.execWith(ctx('s1', b.id), 'tab.previous')
    expect(shown()).toEqual([a.id, a.id])
    await commands.execWith(ctx('s1', a.id), 'tab.previous')
    expect(shown()).toEqual([c.id, c.id])
  })

  it('moves keyboard focus into the tab it shows, and not while a pane is zoomed', async () => {
    const a = createPane()
    const b = createPane()
    useLayoutStore.setState({
      byWorkspace: { s1: { root: tabsOf(a.id, a, b), activePaneId: a.id, zoomedPaneId: null } },
    })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })
    const focusSurface = vi.spyOn(surfaceSlots, 'focusSurface').mockImplementation(() => {})
    await commands.execWith(ctx('s1', a.id), 'tab.next')
    expect(focusSurface).toHaveBeenCalledWith(b.id)

    focusSurface.mockClear()
    useLayoutStore.getState().zoomPane('s1', b.id, true)
    await commands.execWith(ctx('s1', b.id), 'tab.next')
    expect(useLayoutStore.getState().byWorkspace.s1.activePaneId).toBe(b.id)
    expect(focusSurface).not.toHaveBeenCalled()
  })

  it('leaves focus alone when the caller’s pane has no other tabs', async () => {
    const left = createPane()
    const right = createPane()
    useLayoutStore.setState({
      byWorkspace: {
        s1: { root: splitOf('horizontal', left, right), activePaneId: left.id, zoomedPaneId: null },
      },
    })
    const focusPane = vi.spyOn(useLayoutStore.getState(), 'focusPane')
    await commands.execWith(ctx('s1', left.id), 'tab.next')
    await commands.execWith(ctx(null, left.id), 'tab.previous')
    expect(focusPane).not.toHaveBeenCalled()
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

  it('routes workspace.new to showWorkspaces then addWorkspace, in that order', async () => {
    const showWorkspaces = vi
      .spyOn(useUIStore.getState(), 'showWorkspaces')
      .mockImplementation(() => {})
    const addWorkspace = vi
      .spyOn(useWorkspacesStore.getState(), 'addWorkspace')
      .mockImplementation(() => {})

    await commands.execWith(ctx(null, null), 'workspace.new')

    expect(showWorkspaces).toHaveBeenCalled()
    expect(addWorkspace).toHaveBeenCalled()
    expect(showWorkspaces.mock.invocationCallOrder[0]).toBeLessThan(
      addWorkspace.mock.invocationCallOrder[0],
    )
  })

  it('MGR-C29 workspace.new returns the id of the workspace it created', async () => {
    const res = await commands.execWith(ctx(null, null), 'workspace.new', {
      dir: '/home/u/proj',
      name: 'worker',
    })
    const created = useWorkspacesStore.getState().activeWorkspaceId
    expect(created).not.toBeNull()
    expect(res).toEqual({ ok: true, result: { workspaceId: created } })
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

  it('toggles the dashboard from dashboard.toggle without a target', async () => {
    const byId = Object.fromEntries(commands.describe().map((c) => [c.id, c]))
    expect(byId['dashboard.toggle'].target).toBe('none')
    await commands.execWith(ctx(null, null), 'dashboard.toggle')
    expect(useUIStore.getState().dashboardActive).toBe(true)
    await commands.execWith(ctx(null, null), 'dashboard.toggle')
    expect(useUIStore.getState().dashboardActive).toBe(false)
  })

  it('MGR-C43 quits through the window bridge and needs destructive', async () => {
    const byId = Object.fromEntries(commands.describe().map((c) => [c.id, c]))
    expect(byId['app.quit'].capabilities).toEqual(['destructive'])

    await commands.execWith(ctx(null, null), 'app.quit')

    expect(window.ostia.window.quit).toHaveBeenCalled()
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

  it('pane.list reports the open file of a file view', async () => {
    const view = { ...createPane('editor', 'a.ts', '/work/api'), filePath: '/work/api/a.ts' }
    useWorkspacesStore.setState({
      workspaces: [
        { id: 's1', name: 'api', kind: 'terminal', workDir: '/work/api', state: 'idle' },
      ],
    })
    useLayoutStore.setState({
      byWorkspace: { s1: { root: view, activePaneId: view.id, zoomedPaneId: null } },
    })

    const res = await commands.execWith(ctx('s1', null), 'pane.list')

    expect(res).toEqual({
      ok: true,
      result: [
        {
          paneId: view.id,
          workspaceId: 's1',
          kind: 'editor',
          title: 'a.ts',
          cwd: '/work/api',
          filePath: '/work/api/a.ts',
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

  it('pane.list reports the agent, its session id and its state for a terminal pane', async () => {
    const blocksBefore = useBlocksStore.getState()
    const attentionBefore = useAttentionStore.getState()
    const agentPane = {
      ...createPane('terminal', 'claude', '/work/api'),
      resume: { agent: 'claude' as const, id: 'sess-123' },
    }
    const shellPane = createPane('terminal', 'zsh', '/work/api')
    useWorkspacesStore.setState({
      workspaces: [
        { id: 's1', name: 'api', kind: 'terminal', workDir: '/work/api', state: 'idle' },
      ],
    })
    useLayoutStore.setState({
      byWorkspace: {
        s1: {
          root: splitOf('horizontal', agentPane, shellPane),
          activePaneId: agentPane.id,
          zoomedPaneId: null,
        },
      },
    })
    useBlocksStore.setState({
      running: { [agentPane.id]: 'b1' },
      agentBlocks: { [agentPane.id]: { blockId: 'b1', agent: 'claude' } },
    })
    useAttentionStore.setState({
      byPane: {
        [agentPane.id]: { state: 'waiting', unread: true, message: 'Allow Bash?', at: 1 },
        [shellPane.id]: { state: 'none', unread: false, at: 1 },
      },
    })

    try {
      const res = await commands.execWith(ctx('s1', null), 'pane.list')

      expect(res).toEqual({
        ok: true,
        result: [
          {
            paneId: agentPane.id,
            workspaceId: 's1',
            kind: 'terminal',
            title: 'claude',
            cwd: '/work/api',
            agent: 'claude',
            agentSessionId: 'sess-123',
            agentState: 'waiting',
            agentMessage: 'Allow Bash?',
          },
          {
            paneId: shellPane.id,
            workspaceId: 's1',
            kind: 'terminal',
            title: 'zsh',
            cwd: '/work/api',
          },
        ],
      })
    } finally {
      useBlocksStore.setState(blocksBefore, true)
      useAttentionStore.setState(attentionBefore, true)
    }
  })

  it('pane.list keeps the last session id after the agent exits', async () => {
    const pane = {
      ...createPane('terminal', 'zsh', '/work/api'),
      resume: { agent: 'codex' as const, id: 'codex-9' },
    }
    useWorkspacesStore.setState({
      workspaces: [
        { id: 's1', name: 'api', kind: 'terminal', workDir: '/work/api', state: 'idle' },
      ],
    })
    useLayoutStore.setState({
      byWorkspace: { s1: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
    })

    const res = await commands.execWith(ctx('s1', null), 'pane.list')

    expect(res).toEqual({
      ok: true,
      result: [
        {
          paneId: pane.id,
          workspaceId: 's1',
          kind: 'terminal',
          title: 'zsh',
          cwd: '/work/api',
          agentSessionId: 'codex-9',
        },
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

describe('attention.peek / attention.typed', () => {
  const attentionBefore = useAttentionStore.getState()

  afterEach(() => {
    useAttentionStore.setState(attentionBefore, true)
  })

  it('reports a waiting agent with its message and nothing for a quiet pane', async () => {
    useAttentionStore.setState({
      byPane: {
        pW: { state: 'waiting', unread: true, message: 'Allow Bash?', at: 1 },
        pQ: { state: 'none', unread: false, at: 1 },
      },
    })
    expect(await commands.execWith(ctx('s1', 'pW'), 'attention.peek')).toEqual({
      ok: true,
      result: { state: 'waiting', message: 'Allow Bash?' },
    })
    expect(await commands.execWith(ctx('s1', 'pQ'), 'attention.peek')).toEqual({
      ok: true,
      result: {},
    })
  })

  it('ends the wait when input was sent from outside, as typing would', async () => {
    useAttentionStore.setState({
      byPane: { pW: { state: 'waiting', unread: true, message: 'Allow Bash?', at: 1 } },
    })
    await commands.execWith(ctx('s1', 'pW'), 'attention.typed')
    expect(useAttentionStore.getState().byPane.pW?.state).toBe('none')
    const byId = Object.fromEntries(commands.describe().map((c) => [c.id, c]))
    expect(byId['attention.peek'].capabilities).toEqual(['read-board'])
    expect(byId['attention.typed'].capabilities).toEqual(['drive-self'])
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

  it('opens the workspace in the folder and under the name workspace.new was given', async () => {
    const res = await commands.exec('workspace.new', { dir: '/home/u/sonar', name: 'Sonar search' })

    expect(res.ok).toBe(true)
    const [only] = useWorkspacesStore.getState().workspaces
    expect(only).toMatchObject({ workDir: '/home/u/sonar', customName: 'Sonar search' })
  })

  it('refuses a relative dir for workspace.new instead of ignoring it', async () => {
    const res = await commands.exec('workspace.new', { dir: 'sonar' })

    expect(res.ok).toBe(false)
    expect(useWorkspacesStore.getState().workspaces).toEqual([])
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

  it('wakes a hibernated pane and resumes at its first idle prompt', async () => {
    const pane = { ...seedPane({ agent: 'codex', id: 'r-9' }), hibernated: true as const }
    useLayoutStore.setState({
      byWorkspace: { s1: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
    })
    const insert = vi.spyOn(blockActions, 'insertCommand')
    const whenIdle = vi.spyOn(blockActions, 'runWhenIdle').mockReturnValue(() => {})
    const r = await commands.execWith(ctx('s1', pane.id), 'agent.resume')
    expect(r).toMatchObject({ ok: true, result: { resumed: true } })
    expect(useLayoutStore.getState().byWorkspace.s1.root).not.toHaveProperty('hibernated')
    expect(whenIdle).toHaveBeenCalledWith(pane.id, 'codex resume r-9')
    expect(insert).not.toHaveBeenCalled()
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
      groups: [],
      activeWorkspaceId: 'w1',
    })

  it('describes the caller’s own workspace', async () => {
    seed()
    await commands.execWith(ctx('w2', 'p'), 'workspace.describe', { text: 'PR #7' })
    expect(useWorkspacesStore.getState().workspaces[1].description).toBe('PR #7')
    expect(useWorkspacesStore.getState().workspaces[0].description).toBeUndefined()
  })

  it('renames the caller’s own workspace and clears the name with an empty one', async () => {
    seed()
    await commands.execWith(ctx('w2', 'p'), 'workspace.rename', { name: ' W9 控制面補齊 ' })
    expect(useWorkspacesStore.getState().workspaces[1].customName).toBe('W9 控制面補齊')
    expect(useWorkspacesStore.getState().workspaces[0].customName).toBeUndefined()
    const listed = await commands.execWith(ctx(null, null), 'workspace.list')
    expect(listed).toMatchObject({
      ok: true,
      result: [{ workspaceId: 'w1' }, { workspaceId: 'w2', customName: 'W9 控制面補齊' }],
    })
    await commands.execWith(ctx('w2', 'p'), 'workspace.rename', { name: '' })
    expect(useWorkspacesStore.getState().workspaces[1].customName).toBeUndefined()
  })

  it('renames the caller’s pane and pins the title against program titles', async () => {
    seed()
    const pane = createPane('terminal', 'zsh', '/b')
    useLayoutStore.setState({
      byWorkspace: { w2: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
    })
    await commands.execWith(ctx('w2', pane.id), 'pane.rename', { title: 'worker' })
    useLayoutStore.getState().setTitle('w2', pane.id, 'vim')
    const root = useLayoutStore.getState().byWorkspace.w2?.root
    expect(root).toMatchObject({ title: 'worker', titlePinned: true })
    const byId = Object.fromEntries(commands.describe().map((c) => [c.id, c]))
    for (const id of ['pane.rename', 'workspace.rename']) {
      expect(byId[id].capabilities).toEqual(['drive-self'])
      expect(byId[id].hidden).toBe(true)
    }
  })

  it('jumps to a workspace by position and reports a missing one', async () => {
    seed()
    const r = await commands.execWith(ctx(null, null), 'workspace.goto', { index: 1 })
    expect(r).toMatchObject({ ok: true, result: { switched: true } })
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('w2')
    const miss = await commands.execWith(ctx(null, null), 'workspace.goto', { index: 5 })
    expect(miss).toMatchObject({ ok: true, result: { switched: false } })
  })

  it('steps to the next and previous workspace, wrapping at either end', async () => {
    seed()
    await commands.execWith(ctx(null, null), 'workspace.next')
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('w2')
    await commands.execWith(ctx(null, null), 'workspace.next')
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('w1')
    await commands.execWith(ctx(null, null), 'workspace.previous')
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('w2')
  })

  it('moves the caller’s own workspace into a group by name, and out again', async () => {
    seed()
    const r = await commands.execWith(ctx('w2', 'p'), 'workspace.group', { name: 'review' })
    const { workspaces, groups } = useWorkspacesStore.getState()
    expect(groups.map((g) => g.name)).toEqual(['review'])
    expect(r).toEqual({ ok: true, result: { groupId: groups[0].id } })
    expect(workspaces.find((w) => w.id === 'w2')?.groupId).toBe(groups[0].id)
    expect(workspaces.find((w) => w.id === 'w1')?.groupId).toBeUndefined()

    await commands.execWith(ctx('w2', 'p'), 'workspace.ungroup')
    expect(useWorkspacesStore.getState().groups).toEqual([])
  })

  it('refuses a blank group name', async () => {
    seed()
    const r = await commands.execWith(ctx('w2', 'p'), 'workspace.group', { name: '  ' })
    expect(r).toMatchObject({ ok: false })
    expect(useWorkspacesStore.getState().groups).toEqual([])
  })

  it('gates the group verbs on drive-self and lists groups behind read-board', () => {
    const byId = Object.fromEntries(commands.describe().map((c) => [c.id, c]))
    for (const id of ['workspace.group', 'workspace.ungroup', 'workspace.newGroup']) {
      expect(byId[id].capabilities).toEqual(['drive-self'])
      expect(byId[id].target).toBe('active')
    }
    expect(byId['workspace.groups']).toMatchObject({
      hidden: true,
      target: 'none',
      capabilities: ['read-board'],
    })
  })

  it('lists groups with their members and tags grouped workspaces in workspace.list', async () => {
    seed()
    useWorkspacesStore.getState().createGroup('w1', 'api')
    const groupId = useWorkspacesStore.getState().groups[0].id
    useWorkspacesStore.getState().setGroupColor(groupId, 'blue')

    const groups = await commands.execWith(ctx(null, null), 'workspace.groups')
    expect(groups).toEqual({
      ok: true,
      result: [{ groupId, name: 'api', color: 'blue', collapsed: false, workspaceIds: ['w1'] }],
    })
    const list = await commands.execWith(ctx(null, null), 'workspace.list')
    expect(list).toMatchObject({ ok: true, result: [{ workspaceId: 'w1', groupId }, {}] })
    expect((list as { result: object[] }).result[1]).not.toHaveProperty('groupId')
  })

  it('collapses and deletes the active workspace’s group from the palette', async () => {
    seed()
    useWorkspacesStore.getState().createGroup('w1', 'api')
    await commands.execWith(ctx('w1', null), 'workspace.toggleGroup')
    expect(useWorkspacesStore.getState().groups[0].collapsed).toBe(true)
    await commands.execWith(ctx('w1', null), 'workspace.deleteGroup')
    expect(useWorkspacesStore.getState().groups).toEqual([])
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(['w1', 'w2'])
  })

  it('pins the active workspace from the palette', async () => {
    seed()
    await commands.execWith(ctx('w2', null), 'workspace.togglePin')
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(['w2', 'w1'])
    expect(useWorkspacesStore.getState().workspaces[0].pinned).toBe(true)
  })
})

describe('agent notifications', () => {
  const blocksInit = useBlocksStore.getState()
  const attentionInit = useAttentionStore.getState()

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

  afterEach(() => {
    vi.mocked(window.ostia.notifications.post).mockClear()
    useBlocksStore.setState(blocksInit, true)
    useAttentionStore.setState(attentionInit, true)
  })

  it('posts a desktop banner when an agent waits in a pane you are not looking at', async () => {
    const pane = seedPane()
    await commands.execWith(ctx('s1', pane.id), 'attention.set', {
      state: 'waiting',
      message: 'Allow Bash?',
    })
    expect(window.ostia.notifications.post).toHaveBeenCalledWith({
      paneId: pane.id,
      kind: 'waiting',
      title: 'Agent needs your input',
      body: 'Allow Bash?',
      desktop: true,
    })
  })

  it('records a finished agent under the pane title without a banner when agentDone is off', async () => {
    const pane = seedPane()
    useSettingsStore.getState().setNotifications({ agentDone: false })
    await commands.execWith(ctx('s1', pane.id), 'attention.set', { state: 'done' })
    expect(window.ostia.notifications.post).toHaveBeenCalledWith({
      paneId: pane.id,
      kind: 'done',
      title: 'Agent finished',
      body: 'claude',
      desktop: false,
    })
  })

  it('posts nothing for a working state', async () => {
    const pane = seedPane()
    await commands.execWith(ctx('s1', pane.id), 'attention.set', { state: 'working' })
    expect(window.ostia.notifications.post).not.toHaveBeenCalled()
  })

  it('ignores a waiting or working report that arrives after the agent exited to the prompt', async () => {
    const pane = seedPane()
    const blocks = useBlocksStore.getState()
    blocks.promptStart(pane.id, { line: 0 }, null)
    blocks.commandStart(pane.id, { line: 1 }, 'claude')
    blocks.commandEnd(pane.id, { line: 2 }, 0)
    blocks.promptStart(pane.id, { line: 3 }, null)
    for (const state of ['waiting', 'working'] as const) {
      await commands.execWith(ctx('s1', pane.id), 'attention.set', { state })
    }
    expect(useAttentionStore.getState().byPane[pane.id]).toBeUndefined()
    expect(window.ostia.notifications.post).not.toHaveBeenCalled()
  })

  it('accepts a waiting report while the agent command is still running', async () => {
    const pane = seedPane()
    const blocks = useBlocksStore.getState()
    blocks.promptStart(pane.id, { line: 0 }, null)
    blocks.commandStart(pane.id, { line: 1 }, 'claude')
    await commands.execWith(ctx('s1', pane.id), 'attention.set', { state: 'waiting' })
    expect(useAttentionStore.getState().byPane[pane.id]?.state).toBe('waiting')
  })

  it('marks the pane unread, never waiting, for a bus message and logs who sent it', async () => {
    const pane = seedPane()
    await commands.execWith(ctx('s1', pane.id), 'attention.message', {
      from: 'api tests',
      text: 'tests are green\x1b\x07\nsecond line',
    })
    expect(useAttentionStore.getState().byPane[pane.id]).toMatchObject({
      state: 'none',
      unread: true,
      message: 'Message from api tests: tests are green',
    })
    expect(window.ostia.notifications.post).toHaveBeenCalledWith({
      paneId: pane.id,
      kind: 'message',
      title: 'Message from api tests',
      body: 'tests are green',
      desktop: true,
    })
  })

  it('leaves a working agent working when a bus message arrives for it', async () => {
    const pane = seedPane()
    const blocks = useBlocksStore.getState()
    blocks.promptStart(pane.id, { line: 0 }, null)
    blocks.commandStart(pane.id, { line: 1 }, 'claude')
    await commands.execWith(ctx('s1', pane.id), 'attention.set', { state: 'working' })
    await commands.execWith(ctx('s1', pane.id), 'attention.message', { from: '', text: 'ping' })
    expect(useAttentionStore.getState().byPane[pane.id]).toMatchObject({
      state: 'working',
      unread: true,
      message: 'Message from another pane: ping',
    })
  })

  it('keeps what a waiting agent waits for when a bus message arrives', async () => {
    const pane = seedPane()
    const blocks = useBlocksStore.getState()
    blocks.promptStart(pane.id, { line: 0 }, null)
    blocks.commandStart(pane.id, { line: 1 }, 'claude')
    await commands.execWith(ctx('s1', pane.id), 'attention.set', {
      state: 'waiting',
      message: 'Allow Bash?',
    })
    useAttentionStore.getState().dispatch(pane.id, { type: 'view', at: 1 })
    await commands.execWith(ctx('s1', pane.id), 'attention.message', { from: 'web', text: 'hi' })
    expect(useAttentionStore.getState().byPane[pane.id]).toMatchObject({
      state: 'waiting',
      unread: true,
      message: 'Allow Bash?',
    })
  })

  it('reads a bus message at once in the pane being viewed and skips the banner', async () => {
    const pane = seedPane()
    viewWorkspace()
    await commands.execWith(ctx('s1', pane.id), 'attention.message', { from: 'web', text: 'hi' })
    expect(useAttentionStore.getState().byPane[pane.id]?.unread).toBe(false)
    expect(window.ostia.notifications.post).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Message from web', desktop: false }),
    )
  })

  it('tells ostia notify to skip the banner for the pane being viewed unless whenFocused is on', async () => {
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

describe('browser commands', () => {
  it('act on the active browser pane and report when there is none', async () => {
    const handle = {
      guestId: () => 3,
      focusAddress: vi.fn(),
      reload: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      find: vi.fn(),
    }
    const off = registerBrowserHandle('web1', handle)
    try {
      expect(commands.describe().find((c) => c.id === 'browser.reload')?.capabilities).toEqual([
        'browse',
      ])
      expect(await commands.execWith(ctx('s1', 'web1'), 'browser.reload')).toEqual({
        ok: true,
        result: { handled: true },
      })
      await commands.execWith(ctx('s1', 'web1'), 'browser.back')
      await commands.execWith(ctx('s1', 'web1'), 'browser.forward')
      await commands.execWith(ctx('s1', 'web1'), 'browser.focusAddress')
      await commands.execWith(ctx('s1', 'web1'), 'browser.find')
      expect(handle.reload).toHaveBeenCalledTimes(1)
      expect(handle.back).toHaveBeenCalledTimes(1)
      expect(handle.forward).toHaveBeenCalledTimes(1)
      expect(handle.focusAddress).toHaveBeenCalledTimes(1)
      expect(handle.find).toHaveBeenCalledTimes(1)
      expect(await commands.execWith(ctx('s1', 'term1'), 'browser.reload')).toEqual({
        ok: true,
        result: { handled: false },
      })
    } finally {
      off()
    }
  })
})
