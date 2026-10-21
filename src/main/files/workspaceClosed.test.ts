import { describe, expect, it, type Mock, vi } from 'vitest'
import { OpenWaits } from './openWaits'
import { createWorkspaceClosed, type WorkspaceClosedDeps } from './workspaceClosed'

type Step = Exclude<keyof WorkspaceClosedDeps, 'openWaits'>
type StepFn = WorkspaceClosedDeps[Step]

const STEPS: Step[] = [
  'removeWorkspace',
  'forgetReach',
  'closeProcesses',
  'forgetNames',
  'clearChips',
  'closeRemoteFolders',
  'tellExtensions',
  'closeArtifacts',
  'removeScratch',
  'forgetRequests',
  'forgetSandbox',
]

function setup() {
  const openWaits = new OpenWaits()
  const steps = Object.fromEntries(STEPS.map((name) => [name, vi.fn<StepFn>()])) as Record<
    Step,
    Mock<StepFn>
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
