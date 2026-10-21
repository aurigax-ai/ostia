import { DEFAULT_CHORDS } from '@shared/keyboard/defaultChords'
import type { SnapshotWorkspace } from '@shared/workspaces/workspaceApi'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { defaultChords } from '@/lib/keyboard/chords'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { resetWorkspaceIds, useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { commands } from './registry'
import { registerWindowCommands } from './windowCommands'

let settingsInit: ReturnType<typeof useSettingsStore.getState>
let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
let layoutInit: ReturnType<typeof useLayoutStore.getState>

beforeAll(() => {
  settingsInit = useSettingsStore.getState()
  workspacesInit = useWorkspacesStore.getState()
  layoutInit = useLayoutStore.getState()
})

afterEach(() => {
  useSettingsStore.setState(settingsInit, true)
  useWorkspacesStore.setState(workspacesInit, true)
  useLayoutStore.setState(layoutInit, true)
  resetWorkspaceIds()
  commands.unregister('window.new')
  commands.unregister('window.reload')
  commands.unregister('window.moveToMain')
  commands.unregister('workspace.moveToNewWindow')
  commands.unregister('pane.moveToNewWindow')
})

function opened(): SnapshotWorkspace[][] {
  return vi.mocked(window.ostia.windows.openWith).mock.calls.map(([workspaces]) => workspaces)
}

describe('window.new', () => {
  it('opens a window holding one empty terminal workspace in the default folder', async () => {
    registerWindowCommands(false)
    useSettingsStore.getState().setWorkspaces({ defaultFolder: '/srv/code' })

    const res = await commands.exec('window.new')

    expect(res).toEqual({ ok: true, result: { opened: true } })
    const [handoff] = opened()
    expect(handoff).toHaveLength(1)
    expect(handoff[0]).toMatchObject({ kind: 'terminal', workDir: '/srv/code', name: 'code' })
    expect(handoff[0].root).toBeUndefined()
    expect(handoff[0].origin).toBeUndefined()
  })

  it('does not take any workspace from the current window', async () => {
    registerWindowCommands(false)
    useWorkspacesStore.getState().addWorkspace('/home/me')
    const before = useWorkspacesStore.getState().workspaces.map((w) => w.id)

    await commands.exec('window.new')

    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(before)
    expect(opened()[0][0].id).not.toBe(before[0])
  })

  it('starts in the focused pane folder when folders are inherited', async () => {
    registerWindowCommands(false)
    useWorkspacesStore.getState().addWorkspace('/home/me')
    const first = useWorkspacesStore.getState().workspaces[0]
    useLayoutStore.getState().openTerminal(first.id, { cwd: '/tmp/deep' })
    useSettingsStore.getState().setWorkspaces({ inheritFolder: true })

    await commands.exec('window.new')

    expect(opened()[0][0].workDir).toBe('/tmp/deep')
  })

  it('reports opened false when main refuses the window', async () => {
    registerWindowCommands(false)
    vi.mocked(window.ostia.windows.openWith).mockResolvedValueOnce(false)

    const res = await commands.exec('window.new')

    expect(res).toEqual({ ok: true, result: { opened: false } })
  })

  it('is available from a detached window too, next to Move Back to Main Window', async () => {
    registerWindowCommands(true)

    expect(commands.has('window.new')).toBe(true)
    expect(commands.has('window.moveToMain')).toBe(true)
    expect(commands.has('workspace.moveToNewWindow')).toBe(false)
    await commands.exec('window.new')
    expect(opened()).toHaveLength(1)
  })
})

describe('workspace.moveToNewWindow', () => {
  it('is listed in the palette and hands the active workspace to a new window', async () => {
    registerWindowCommands(false)
    useWorkspacesStore.getState().addWorkspace('/home/me')
    const id = useWorkspacesStore.getState().workspaces[0].id

    const entry = commands.describe().find((c) => c.id === 'workspace.moveToNewWindow')
    expect(entry?.hidden).toBeFalsy()
    const res = await commands.execWith(
      { activeWorkspaceId: id, activePaneId: null },
      'workspace.moveToNewWindow',
    )

    expect(res).toMatchObject({ ok: true })
    expect(window.ostia.windows.detach).toHaveBeenCalledTimes(1)
    expect(vi.mocked(window.ostia.windows.detach).mock.calls[0][0].id).toBe(id)
  })
})

describe('window.reload', () => {
  it('asks main to reload the window through its recovery path, and nothing else', async () => {
    registerWindowCommands(false)

    const res = await commands.exec('window.reload')

    expect(res.ok).toBe(true)
    expect(window.ostia.diagnostics.reloadWindow).toHaveBeenCalledTimes(1)
    expect(window.ostia.windows.openWith).not.toHaveBeenCalled()
  })

  it('is available in a detached window too', () => {
    registerWindowCommands(true)

    expect(commands.has('window.reload')).toBe(true)
  })

  it('has no default shortcut on any platform', () => {
    expect(DEFAULT_CHORDS).not.toHaveProperty('window.reload')
    expect(defaultChords('window.reload', true)).toEqual([])
    expect(defaultChords('window.reload', false)).toEqual([])
  })
})
