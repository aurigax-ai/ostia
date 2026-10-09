import { commands } from '@/commands/registry'
import { DashboardPanel } from '@/components/agents/DashboardPanel'
import { PaneTree } from '@/components/panes/PaneTree'
import { SurfacePool } from '@/components/panes/SurfacePool'
import { SettingsPanel } from '@/components/settings/SettingsPanel'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty'
import { Kbd } from '@/components/ui/kbd'
import { useDict } from '@/i18n/useDict'
import { workspacesAwaitingResume } from '@/lib/autoResume'
import { useChordLabel } from '@/lib/chords'
import { startNewWorkspace } from '@/lib/newWorkspace'
import { isMac } from '@/platform'
import { useLayoutStore } from '@/stores/layoutStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { coversWorkspaces, useUIStore } from '@/stores/uiStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import { PlusIcon, TerminalWindowIcon } from '@phosphor-icons/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export function WorkZone(): JSX.Element {
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const covered = useUIStore(coversWorkspaces)
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
          <WorkspaceLayer key={id} workspaceId={id} active={id === activeWorkspaceId && !covered} />
        ))}
      <SurfacePool />
      <SettingsPanel />
      <DashboardPanel />
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
  const newWorkspaceKeys = useChordLabel('workspace.new', isMac)
  const newTerminalKeys = useChordLabel('tab.new', isMac)
  return (
    <Empty className="workzone-empty">
      <EmptyHeader>
        <EmptyTitle className="font-semibold text-fg text-ui-lg">
          <h2>{d.workzone.emptyTitle}</h2>
        </EmptyTitle>
        <EmptyDescription className="text-ui-base">{d.workzone.emptyBody}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        <Button
          onClick={() => {
            showWorkspaces()
            startNewWorkspace()
          }}
        >
          <PlusIcon data-icon="inline-start" />
          {d.rail.newWorkspace}
          {newWorkspaceKeys ? (
            <Kbd className="ml-1 bg-primary-foreground/15 text-primary-foreground">
              {newWorkspaceKeys}
            </Kbd>
          ) : null}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            showWorkspaces()
            void commands.exec('tab.new')
          }}
        >
          <TerminalWindowIcon data-icon="inline-start" />
          {d.pane.newTerminal}
          {newTerminalKeys ? <Kbd className="ml-1">{newTerminalKeys}</Kbd> : null}
        </Button>
      </EmptyContent>
    </Empty>
  )
}
