import type { ExtensionInfo } from '@shared/extensions'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { findPane, paneIds, resetIds } from '../layout/tree'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { openExtensionPanel, syncExtensionCommands } from './extensionBridge'
import { commands } from './registry'

function ext(overrides: Partial<ExtensionInfo> = {}): ExtensionInfo {
  return {
    id: 'kanban',
    name: 'Kanban',
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
      { id: 'add', title: 'Add', palette: false, stdin: false, capabilities: ['board-write'] },
    ],
    panel: { title: 'Board', icon: 'kanban' },
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
    resetIds()
  })

  it('registers palette commands of enabled extensions under <extId>.<command>', () => {
    syncExtensionCommands([ext()])
    const cmd = commands.describe().find((c) => c.id === 'kanban.open')
    expect(cmd).toMatchObject({
      title: 'Open Board',
      category: 'App',
      capabilities: ['read-board'],
    })
    expect(commands.has('kanban.add')).toBe(false)
  })

  it('removes the commands when the extension is disabled, and notifies subscribers', () => {
    const listener = vi.fn()
    const unsubscribe = commands.subscribe(listener)
    syncExtensionCommands([ext()])
    syncExtensionCommands([ext({ enabled: false })])
    unsubscribe()
    expect(commands.has('kanban.open')).toBe(false)
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
      'kanban.open',
    )
    expect(invoke).toHaveBeenCalledWith('kanban', 'open', { sessionId: 's1', paneId: 'pane-1' })
    expect(res).toEqual({ ok: true, result: { opened: true } })
  })

  it('surfaces an extension failure as a failed command', async () => {
    window.pine.extensions.invoke = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'extension-unavailable', message: 'crashed' })
    syncExtensionCommands([ext()])
    const res = await commands.execWith(
      { activeSessionId: 's1', activePaneId: null },
      'kanban.open',
    )
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

    openExtensionPanel({ extId: 'kanban', sessionId: 's1' })
    openExtensionPanel({ extId: 'kanban', sessionId: 'unknown-session' })
    openExtensionPanel({ extId: 'ghost' })

    const root = useLayoutStore.getState().bySession.s1.root
    const panels = paneIds(root)
      .map((id) => findPane(root, id))
      .filter((p) => p?.kind === 'extension')
    expect(panels).toHaveLength(1)
    expect(panels[0]).toMatchObject({ extensionId: 'kanban', title: 'Board' })
  })
})
