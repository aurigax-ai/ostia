import '@testing-library/jest-dom/vitest'
import { CloseConfirmDialog } from '@/components/rail/CloseConfirmDialog'
import type { AppSnapshot } from '@shared/types'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetIds } from '../layout/tree'
import { requestClosePane, requestCloseWorkspace } from '../lib/closeConfirm'
import { useCloseConfirmStore } from '../stores/closeConfirmStore'
import { useLayoutStore } from '../stores/layoutStore'
import { saveSnapshotNow } from '../stores/persistence'
import { useSettingsStore } from '../stores/settingsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { openManagerWorkspace } from './managerBridge'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const managerWorkspaces = () =>
  useWorkspacesStore.getState().workspaces.filter((w) => w.kind === 'manager')

const lastSnapshot = (): AppSnapshot => {
  const calls = vi.mocked(window.ostia.workspace.save).mock.calls.filter((c) => c[0] !== null)
  const snapshot = calls.at(-1)?.[0]
  if (!snapshot) throw new Error('no snapshot was saved')
  return snapshot
}

describe('manager workspace', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  beforeEach(() => resetIds())

  afterEach(() => {
    cleanup()
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useSettingsStore.setState(settingsInit, true)
    useCloseConfirmStore.setState({ pending: null })
    vi.mocked(window.ostia.workspace.save).mockClear()
  })

  it('MGR-C9 opens a manager workspace holding one manager pane at the caller cwd', () => {
    const paneId = openManagerWorkspace({ agent: 'claude', cwd: '/home/u/proj' })
    const [workspace] = managerWorkspaces()
    expect(workspace?.customName ?? workspace?.name).toBe('Manager · claude')
    expect(workspace?.workDir).toBe('/home/u/proj')
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe(workspace?.id)
    const root = workspace ? useLayoutStore.getState().byWorkspace[workspace.id]?.root : undefined
    expect(root).toMatchObject({ type: 'pane', id: paneId, kind: 'manager', cwd: '/home/u/proj' })
  })

  it('MGR-C23 replaces the workspace of a manager that already ended', () => {
    openManagerWorkspace({ agent: 'claude', cwd: '/a' })
    openManagerWorkspace({ agent: 'codex', cwd: '/b' })
    const managers = managerWorkspaces()
    expect(managers).toHaveLength(1)
    expect(managers[0]?.workDir).toBe('/b')
  })

  it('MGR-C25 never saves the manager workspace', () => {
    useWorkspacesStore.getState().addWorkspace('/work')
    openManagerWorkspace({ agent: 'claude', cwd: '/home/u' })
    saveSnapshotNow()
    const snapshot = lastSnapshot()
    expect(snapshot.workspaces.map((w) => w.workDir)).toEqual(['/work'])
    expect(snapshot.activeWorkspaceId).toBe(snapshot.workspaces[0]?.id)
  })

  it('MGR-C26 asks before closing the manager workspace, and keeps it on Cancel', async () => {
    openManagerWorkspace({ agent: 'claude', cwd: '/home/u' })
    const [workspace] = managerWorkspaces()
    if (!workspace) throw new Error('no manager workspace')
    render(<CloseConfirmDialog />)
    const user = userEvent.setup()

    const closing = requestCloseWorkspace(workspace.id)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Manager · claude')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(() => closing)
    expect(managerWorkspaces()).toHaveLength(1)
  })

  it('MGR-C26 asks before closing the manager pane itself', async () => {
    const paneId = openManagerWorkspace({ agent: 'claude', cwd: '/home/u' })
    const [workspace] = managerWorkspaces()
    if (!workspace || !paneId) throw new Error('no manager workspace')
    render(<CloseConfirmDialog />)
    const user = userEvent.setup()

    const closing = requestClosePane(workspace.id, paneId)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Manager · claude')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(() => closing)
    expect(useLayoutStore.getState().byWorkspace[workspace.id]).toBeDefined()
  })
})
