import '@testing-library/jest-dom/vitest'
import type { AppSnapshot } from '@shared/workspaces/workspaceApi'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloseConfirmDialog } from '@/components/sidebar/CloseConfirmDialog'
import { resetIds } from '@/lib/layout/tree'
import { requestClosePane, requestCloseWorkspace } from '@/lib/workspaces/closeConfirm'
import { useAgentStore } from '@/stores/agent/agentStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useChatToolsStore } from '@/stores/assist/chatToolsStore'
import { useCloseConfirmStore } from '@/stores/workspaces/closeConfirmStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { saveSnapshotNow } from '@/stores/workspaces/persistence'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
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

  it('MGR-C9 opens a manager workspace holding one manager pane at the caller cwd', async () => {
    const paneId = await openManagerWorkspace({
      agent: 'claude',
      cwd: '/home/u/proj',
      session: false,
    })
    const [workspace] = managerWorkspaces()
    expect(workspace?.customName ?? workspace?.name).toBe('Manager · claude')
    expect(workspace?.workDir).toBe('/home/u/proj')
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe(workspace?.id)
    const root = workspace ? useLayoutStore.getState().byWorkspace[workspace.id]?.root : undefined
    expect(root).toMatchObject({ type: 'pane', id: paneId, kind: 'manager', cwd: '/home/u/proj' })
    expect(root).not.toHaveProperty('managerSession')
  })

  it('PIM-C10 opens the pi manager as one session pane whose composer starts in Allow', async () => {
    const paneId = await openManagerWorkspace({ agent: 'pi', cwd: '/home/u/proj', session: true })
    const [workspace] = managerWorkspaces()
    if (!workspace || !paneId) throw new Error('no manager workspace')
    const root = useLayoutStore.getState().byWorkspace[workspace.id]?.root
    expect(root).toMatchObject({ type: 'pane', id: paneId, kind: 'manager', managerSession: true })
    const sessionId = useAgentStore.getState().current[workspace.id]
    expect(sessionId).toBeDefined()
    expect(useChatToolsStore.getState().mode[sessionId ?? '']).toBe('write')
    expect(window.ostia.agentSessions.open).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ workspaceId: workspace.id, paneId }),
    )
  })

  it('MGR-C23 replaces the workspace of a manager that already ended', async () => {
    await openManagerWorkspace({ agent: 'claude', cwd: '/a', session: false })
    await openManagerWorkspace({ agent: 'codex', cwd: '/b', session: false })
    const managers = managerWorkspaces()
    expect(managers).toHaveLength(1)
    expect(managers[0]?.workDir).toBe('/b')
  })

  it('MGR-C25 never saves the manager workspace', async () => {
    useWorkspacesStore.getState().addWorkspace('/work')
    await openManagerWorkspace({ agent: 'claude', cwd: '/home/u', session: false })
    saveSnapshotNow()
    const snapshot = lastSnapshot()
    expect(snapshot.workspaces.map((w) => w.workDir)).toEqual(['/work'])
    expect(snapshot.activeWorkspaceId).toBe(snapshot.workspaces[0]?.id)
  })

  it('MGR-C26 asks before closing the manager workspace, and keeps it on Cancel', async () => {
    await openManagerWorkspace({ agent: 'claude', cwd: '/home/u', session: false })
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
    const paneId = await openManagerWorkspace({ agent: 'claude', cwd: '/home/u', session: false })
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
