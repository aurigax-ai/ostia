import type { AppSnapshot } from '@shared/workspaces/workspaceApi'
import { useSidePanelStore } from '@/stores/app/sidePanelStore'
import { useUIStore } from '@/stores/app/uiStore'

export function restoreSidePanels(snapshot: AppSnapshot | null): void {
  useUIStore.setState({ filesOpen: snapshot?.leftPanel === 'files' })
  useSidePanelStore.setState({ right: snapshot?.rightPanel ?? null })
}
