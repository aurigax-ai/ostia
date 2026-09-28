import { useLayoutStore } from '../stores/layoutStore'
import { useSessionsStore } from '../stores/sessionsStore'

export function openFileInWorkspace(path: string): void {
  if (!useSessionsStore.getState().activeSessionId) useSessionsStore.getState().addSession()
  const sessionId = useSessionsStore.getState().activeSessionId
  if (sessionId) useLayoutStore.getState().openFile(sessionId, path)
}
