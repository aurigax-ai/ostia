import { useLayoutStore } from '../stores/layoutStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { resumeOnActivation } from './autoResume'

const HUMAN_INPUT = ['pointerdown', 'mousedown', 'click', 'keydown', 'keyup'] as const

interface ActivePane {
  workspaceId: string
  paneId: string
}

function activePane(): ActivePane | null {
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  const paneId = workspaceId
    ? useLayoutStore.getState().byWorkspace[workspaceId]?.activePaneId
    : undefined
  return workspaceId && paneId ? { workspaceId, paneId } : null
}

export function startActivationResume(): () => void {
  let humanInput = false
  let last = activePane()

  const onInput = (e: Event): void => {
    if (!e.isTrusted || humanInput) return
    humanInput = true
    setTimeout(() => {
      humanInput = false
    }, 0)
  }

  const check = (): void => {
    const next = activePane()
    const moved = next?.workspaceId !== last?.workspaceId || next?.paneId !== last?.paneId
    last = next
    if (moved && next && humanInput) resumeOnActivation(next.paneId)
  }

  for (const type of HUMAN_INPUT) window.addEventListener(type, onInput, true)
  const unsubscribe = [useLayoutStore.subscribe(check), useWorkspacesStore.subscribe(check)]
  return () => {
    for (const type of HUMAN_INPUT) window.removeEventListener(type, onInput, true)
    for (const off of unsubscribe) off()
  }
}
