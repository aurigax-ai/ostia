import '@testing-library/jest-dom/vitest'
import { resetIds } from '@/layout/tree'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { resetWorkspaceIds, useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { DetachedTitleBar } from './DetachedTitleBar'

let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
let layoutInit: ReturnType<typeof useLayoutStore.getState>

beforeAll(() => {
  workspacesInit = useWorkspacesStore.getState()
  layoutInit = useLayoutStore.getState()
})

afterEach(() => {
  cleanup()
  useWorkspacesStore.setState(workspacesInit, true)
  useLayoutStore.setState(layoutInit, true)
  resetIds()
  resetWorkspaceIds()
})

it('a pane moved to a new window rejoins its workspace when it comes back', async () => {
  useWorkspacesStore.getState().addWorkspace('/home/u/api')
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId as string
  useLayoutStore.getState().ensure(workspaceId)
  const paneId = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
  render(<DetachedTitleBar />)

  await userEvent.setup().click(screen.getByRole('button', { name: 'Move back to main window' }))

  await waitFor(() => expect(window.ostia.windows.returnToMain).toHaveBeenCalledTimes(1))
  const [sent] = vi.mocked(window.ostia.windows.returnToMain).mock.calls[0]
  expect(sent).toEqual([
    expect.objectContaining({ id: workspaceId, root: expect.objectContaining({ id: paneId }) }),
  ])
})
