import { PlusIcon, TerminalWindowIcon } from '@phosphor-icons/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { commands } from '@/commands/registry'
import { NoNewPrivsStatus } from '@/components/app/NoNewPrivsStatus'
import { ChordButton } from '@/components/common/ChordButton'
import { EmptyState } from '@/components/common/EmptyState'
import { PaneTree } from '@/components/panes/PaneTree'
import { SurfacePool } from '@/components/panes/SurfacePool'
import { SettingsPanel } from '@/components/settings/SettingsPanel'
import { workspacesAwaitingResume } from '@/lib/agents/autoResume'
import { useDict } from '@/lib/app/useDict'
import { startNewWorkspace } from '@/lib/workspaces/newWorkspace'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

export function WorkZone(): JSX.Element {
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const settingsActive = useUIStore((s) => s.settingsActive)
  const autoResume = useSettingsStore((s) => s.agents.autoResume)
  const awaitingResume = useLayoutStore((s) =>
    autoResume ? workspacesAwaitingResume(s.byWorkspace).join('\n') : '',
  )
  const [mounted, setMounted] = useState<string[]>(() =>
    activeWorkspaceId ? [activeWorkspaceId] : [],
  )

  useEffect(() => {
    const wanted = [
      ...(activeWorkspaceId ? [activeWorkspaceId] : []),
      ...(awaitingResume ? awaitingResume.split('\n') : []),
    ]
    setMounted((m) => {
      const added = wanted.filter((id) => !m.includes(id))
      return added.length === 0 ? m : [...m, ...added]
    })
  }, [activeWorkspaceId, awaitingResume])

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
      <NoNewPrivsStatus />
      <SurfacePool />
      <SettingsPanel />
    </section>
  )
}

function WorkspaceLayer({
  workspaceId,
  active,
}: {
  workspaceId: string
  active: boolean
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (ref.current) ref.current.inert = !active
  }, [active])
  return (
    <div
      ref={ref}
      className="workzone-workspace"
      data-hidden={active ? undefined : ''}
      aria-hidden={!active}
    >
      <PaneTree workspaceId={workspaceId} />
    </div>
  )
}

function NoWorkspaces(): JSX.Element {
  const d = useDict()
  const showWorkspaces = useUIStore((s) => s.showWorkspaces)
  return (
    <EmptyState
      variant="surface"
      className="workzone-empty"
      title={d.workzone.emptyTitle}
      titleAs="h2"
      desc={d.workzone.emptyBody}
      actionsClassName="flex-row justify-center"
      actions={
        <>
          <ChordButton
            command="workspace.new"
            icon={<PlusIcon data-icon="inline-start" />}
            label={d.rail.newWorkspace}
            onClick={() => {
              showWorkspaces()
              startNewWorkspace()
            }}
          />
          <ChordButton
            command="tab.new"
            variant="outline"
            icon={<TerminalWindowIcon data-icon="inline-start" />}
            label={d.pane.newTerminal}
            onClick={() => {
              showWorkspaces()
              void commands.exec('tab.new')
            }}
          />
        </>
      }
    />
  )
}
