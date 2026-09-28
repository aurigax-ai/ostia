import type { ExtensionInfo } from '@shared/extensions'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { findPane, paneIds, resetIds } from '../layout/tree'
import { useDiffStore } from '../stores/diffStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { openExtensionDiff, openExtensionPanel, syncExtensionCommands } from './extensionBridge'
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
    ...overrides,
  }
}

describe('extensionBridge', () => {
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let sessionsInit: ReturnType<typeof useSessionsStore.getState>
  let extInit: ReturnType<typeof useExtensionsStore.getState>

  beforeAll(() => {
    layoutInit = useLayoutStore.getState()
    sessionsInit = useSessionsStore.getState()
    extInit = useExtensionsStore.getState()
  })

  afterEach(() => {
    syncExtensionCommands([])
    useLayoutStore.setState(layoutInit, true)
    useSessionsStore.setState(sessionsInit, true)
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

  it('running a command invokes the extension with the active session and pane', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, data: { opened: true } })
    window.pine.extensions.invoke = invoke
    syncExtensionCommands([ext()])
    const res = await commands.execWith(
      { activeSessionId: 's1', activePaneId: 'pane-1' },
      'demo.open',
    )
    expect(invoke).toHaveBeenCalledWith('demo', 'open', { sessionId: 's1', paneId: 'pane-1' })
    expect(res).toEqual({ ok: true, result: { opened: true } })
  })

  it('surfaces an extension failure as a failed command', async () => {
    window.pine.extensions.invoke = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'extension-unavailable', message: 'crashed' })
    syncExtensionCommands([ext()])
    const res = await commands.execWith({ activeSessionId: 's1', activePaneId: null }, 'demo.open')
    expect(res).toEqual({
      ok: false,
      error: { code: 'command-failed', message: 'extension-unavailable: crashed' },
    })
  })

  it('openExtensionPanel opens one panel pane per extension in the requested session', () => {
    useSessionsStore.setState({
      sessions: [{ id: 's1', name: 'a', kind: 'terminal', workDir: '/a', state: 'idle' }],
      activeSessionId: 's1',
    })
    useLayoutStore.getState().ensure('s1')
    useExtensionsStore.setState({ list: [ext()] })

    openExtensionPanel({ extId: 'demo', sessionId: 's1' })
    openExtensionPanel({ extId: 'demo', sessionId: 'unknown-session' })
    openExtensionPanel({ extId: 'ghost' })

    const root = useLayoutStore.getState().bySession.s1.root
    const panels = paneIds(root)
      .map((id) => findPane(root, id))
      .filter((p) => p?.kind === 'extension')
    expect(panels).toHaveLength(1)
    expect(panels[0]).toMatchObject({ extensionId: 'demo', title: 'Board' })
  })

  it('openExtensionDiff opens one reusable diff pane and stores its content by pane id', () => {
    useSessionsStore.setState({
      sessions: [{ id: 's1', name: 'a', kind: 'terminal', workDir: '/a', state: 'idle' }],
      activeSessionId: 's1',
    })
    useLayoutStore.getState().ensure('s1')
    const first = openExtensionDiff({
      extId: 'vcs',
      sessionId: 's1',
      title: 'a.ts',
      original: 'x',
      modified: 'y',
      path: '/repo/src/a.ts',
    })
    const second = openExtensionDiff({
      extId: 'vcs',
      sessionId: 'gone',
      title: 'b.ts',
      original: '1',
      modified: '2',
    })

    expect(second).toBe(first)
    const layout = useLayoutStore.getState().bySession.s1
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
    useSessionsStore.setState({
      sessions: [{ id: 's1', name: 'a', kind: 'terminal', workDir: '/a', state: 'idle' }],
      activeSessionId: 's1',
    })
    useLayoutStore.getState().ensure('s1')
    const id = openExtensionDiff({
      extId: 'vcs',
      title: 'a.ts',
      original: '',
      modified: '',
      path: '/repo/src/a.ts',
    })
    const root = useLayoutStore.getState().bySession.s1.root
    expect(findPane(root, id as string)?.cwd).toBe('/repo/src')
  })
})
