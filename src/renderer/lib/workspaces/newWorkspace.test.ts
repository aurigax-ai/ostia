import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { newWorkspaceDir, startNewWorkspace } from './newWorkspace'

describe('newWorkspaceDir', () => {
  it('uses the focused pane folder only when inheriting', () => {
    expect(newWorkspaceDir(true, '~', '/tmp/x')).toBe('/tmp/x')
    expect(newWorkspaceDir(false, '~', '/tmp/x')).toBe('~')
  })

  it('falls back to the default folder when the pane has no cwd', () => {
    expect(newWorkspaceDir(true, '/work', undefined)).toBe('/work')
  })
})

describe('startNewWorkspace', () => {
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
  })

  it('starts in the focused pane folder and at the configured position', () => {
    useWorkspacesStore.getState().addWorkspace('/home/me')
    const first = useWorkspacesStore.getState().workspaces[0]
    useLayoutStore.getState().openTerminal(first.id, { cwd: '/tmp/deep' })
    useSettingsStore.getState().setWorkspaces({ inheritFolder: true, placement: 'top' })

    startNewWorkspace()

    const [added, original] = useWorkspacesStore.getState().workspaces
    expect(added.workDir).toBe('/tmp/deep')
    expect(original.id).toBe(first.id)
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe(added.id)
  })

  it('uses the default folder when inheriting is off', () => {
    useWorkspacesStore.getState().addWorkspace('/home/me')
    useSettingsStore.getState().setWorkspaces({ defaultFolder: '/srv/code' })

    startNewWorkspace()

    expect(useWorkspacesStore.getState().workspaces[1].workDir).toBe('/srv/code')
  })
})
