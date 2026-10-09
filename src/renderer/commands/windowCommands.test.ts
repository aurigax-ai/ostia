import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { resetWorkspaceIds, useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { SnapshotWorkspace } from '@shared/types'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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
