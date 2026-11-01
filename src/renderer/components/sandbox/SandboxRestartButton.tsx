import { ArrowClockwiseIcon } from '@phosphor-icons/react'
import { type JSX, useEffect } from 'react'
import { Hint } from '@/components/common/Hint'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useDict } from '@/lib/app/useDict'
import type { PaneNode } from '@/lib/layout/types'
import { needsSandboxRestart, useSandboxStore } from '@/stores/app/sandboxStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

export function SandboxRestartButton({ pane }: { pane: PaneNode }): JSX.Element | null {
  const d = useDict()
  const workspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const stale = useSandboxStore((s) =>
    workspaceId ? needsSandboxRestart(s, workspaceId, pane.id) : false,
  )
  useEffect(() => {
    if (workspaceId) void useSandboxStore.getState().load(workspaceId)
  }, [workspaceId])
  if (pane.kind !== 'terminal' || !stale) return null
  return (
    <Hint label={d.pane.sandboxRestartHint}>
      <Button
        variant="outline"
        size="xs"
        onClick={() => void useSandboxStore.getState().restart(pane.id)}
      >
        <ArrowClockwiseIcon data-icon="inline-start" aria-hidden />
        {d.pane.sandboxRestart}
      </Button>
    </Hint>
  )
}

export function HostPaneBadge({ pane }: { pane: PaneNode }): JSX.Element | null {
  const d = useDict()
  const host = useSandboxStore((s) => s.hostPanes[pane.id] ?? false)
  if (!host) return null
  return (
    <Hint label={d.pane.hostHint}>
      <Badge variant="outline">{d.pane.host}</Badge>
    </Hint>
  )
}
