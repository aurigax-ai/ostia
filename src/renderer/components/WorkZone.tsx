import { PlusIcon } from '@phosphor-icons/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDict } from '../i18n/useDict'
import { chordLabel } from '../lib/chords'
import { isMac } from '../platform'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { PaneTree } from './PaneTree'
import { SettingsPanel } from './SettingsPanel'
import { SurfacePool } from './SurfacePool'
import { Button } from './ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from './ui/empty'
import { Kbd } from './ui/kbd'

const NEW_WORKSPACE_KEYS = chordLabel('workspace.new', isMac)

export function WorkZone(): JSX.Element {
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const settingsActive = useUIStore((s) => s.settingsActive)
  const [mounted, setMounted] = useState<string[]>(() =>
    activeWorkspaceId ? [activeWorkspaceId] : [],
  )

  useEffect(() => {
    if (!activeWorkspaceId) return
    setMounted((m) => (m.includes(activeWorkspaceId) ? m : [...m, activeWorkspaceId]))
  }, [activeWorkspaceId])

  useEffect(() => {
    setMounted((m) => {
      const alive = m.filter((id) => workspaces.some((s) => s.id === id))
      return alive.length === m.length ? m : alive
    })
  }, [workspaces])

  return (
    <section className="workzone relative">
      {workspaces.length === 0 ? <NoWorkspaces /> : null}
      {mounted
        .filter((id) => workspaces.some((s) => s.id === id))
        .map((id) => (
          <WorkspaceLayer
            key={id}
            workspaceId={id}
            active={id === activeWorkspaceId && !settingsActive}
          />
        ))}
      <SurfacePool />
      <SettingsPanel />
    </section>
  )
}

function WorkspaceLayer({
  workspaceId,
  active,
}: { workspaceId: string; active: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (ref.current) ref.current.inert = !active
  }, [active])
  return (
    <div
      ref={ref}
      className="workzone-workspace"
      style={{ visibility: active ? 'visible' : 'hidden' }}
      aria-hidden={!active}
    >
      <PaneTree workspaceId={workspaceId} />
    </div>
  )
}

function NoWorkspaces(): JSX.Element {
  const d = useDict()
  const addWorkspace = useWorkspacesStore((s) => s.addWorkspace)
  const leaveSettings = useUIStore((s) => s.leaveSettings)
  return (
    <Empty className="workzone-empty">
      <EmptyHeader>
        <EmptyTitle className="font-semibold text-fg text-ui-lg">
          <h2>{d.workzone.emptyTitle}</h2>
        </EmptyTitle>
        <EmptyDescription className="text-ui-base">{d.workzone.emptyBody}</EmptyDescription>
      </EmptyHeader>
      <Button
        onClick={() => {
          leaveSettings()
          addWorkspace()
        }}
      >
        <PlusIcon data-icon="inline-start" />
        {d.rail.newWorkspace}
        <Kbd className="ml-1 bg-primary-foreground/15 text-primary-foreground">
          {NEW_WORKSPACE_KEYS}
        </Kbd>
      </Button>
    </Empty>
  )
}
