import { describe, expect, it, vi } from 'vitest'
import { OpenWaits } from './openWaits'
import { type WorkspaceClosedDeps, createWorkspaceClosed } from './workspaceClosed'

type Step = Exclude<keyof WorkspaceClosedDeps, 'openWaits'>

const STEPS: Step[] = [
  'removeWorkspace',
  'forgetReach',
  'closeProcesses',
  'clearChips',
  'closeRemoteFolders',
  'closeArtifacts',
  'removeScratch',
  'forgetRequests',
  'forgetSandbox',
]

function setup() {
  const openWaits = new OpenWaits()
  const steps = Object.fromEntries(STEPS.map((name) => [name, vi.fn()])) as Record<
    Step,
    ReturnType<typeof vi.fn>
  >
  return { openWaits, steps, closed: createWorkspaceClosed({ openWaits, ...steps }) }
}

describe('createWorkspaceClosed', () => {
  it('closing the workspace ends a waiting editor with a failure instead of hanging', async () => {
    const { openWaits, closed } = setup()
    const mine = openWaits.start({
      windowId: '1',
      workspaceId: 'w1',
      callerPaneId: 'term',
      paneIds: ['notes'],
    })
    const other = openWaits.start({
      windowId: '1',
      workspaceId: 'w2',
      callerPaneId: 't2',
      paneIds: ['other'],
    })
    closed('w1')
    expect(openWaits.size).toBe(1)
    expect(await mine.done).toBe('gone')
    openWaits.paneClosed('other')
    expect(await other.done).toBe('closed')
  })

  it.each(STEPS)('tells %s which workspace closed', (step) => {
    const { steps, closed } = setup()
    closed('w1')
    expect(steps[step]).toHaveBeenCalledWith('w1')
  })
})
