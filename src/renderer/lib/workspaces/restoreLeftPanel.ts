import { useUIStore } from '@/stores/app/uiStore'
import type { AppSnapshot } from '@shared/workspaces/workspaceApi'

export function restoreLeftPanel(snapshot: AppSnapshot | null): void {
  useUIStore.setState({ filesOpen: snapshot?.leftPanel === 'files' })
}
