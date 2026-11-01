import type { JSX } from 'react'
import type { SurfaceKind } from '@/lib/layout/types'
import { useSandboxStore } from '@/stores/app/sandboxStore'

function coversFileDrop(kind: SurfaceKind, sandboxed: boolean): boolean {
  if (kind === 'terminal') return false
  return kind !== 'browser' || sandboxed
}

export function FileDropCover({
  kind,
  workspaceId,
}: {
  kind: SurfaceKind
  workspaceId: string
}): JSX.Element | null {
  const sandboxed = useSandboxStore((s) => s.enabled[workspaceId] === true)
  return coversFileDrop(kind, sandboxed) ? <div className="pane-file-drop" /> : null
}
