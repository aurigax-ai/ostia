import { XIcon } from '@phosphor-icons/react'
import type { ResumableAgent } from '@shared/agentResume'
import type { AttentionState } from '@shared/types'
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { Dict } from '../i18n/dict'
import { fmt, useDict } from '../i18n/useDict'
import { sessionTitle } from '../lib/agentSession'
import { runningAgent } from '../lib/paneAgent'
import { type PickTarget, pickTargets } from '../lib/pickTargets'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useOriginAgentsStore } from '../stores/originAgentsStore'
import { usePaneRecencyStore } from '../stores/paneRecencyStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { IconButton } from './IconButton'
import { Button } from './ui/button'
import { Label } from './ui/label'
import { RadioGroup, RadioGroupItem } from './ui/radio-group'
import { Textarea } from './ui/textarea'

export function stateLabel(d: Dict, state: AttentionState): string {
  switch (state) {
    case 'working':
      return d.rail.stateWorking
    case 'waiting':
      return d.rail.stateWaiting
    case 'done':
      return d.rail.stateDone
    case 'error':
      return d.rail.stateError
    default:
      return d.rail.stateIdle
  }
}

export function agentLabel(d: Dict, title: string, agent: ResumableAgent | 'other'): string {
  if (agent === 'other') return title
  const name = d.agentSession[agent]
  const session = sessionTitle(title, agent)
  return session ? `${name} · ${session}` : name
}

export function useLocalAgentTargets(workspaceId: string): PickTarget[] {
  const d = useDict()
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const layouts = useLayoutStore((s) => s.byWorkspace)
  const attention = useAttentionStore((s) => s.byPane)
  const touchedAt = usePaneRecencyStore((s) => s.touchedAt)
  const running = useBlocksStore((s) => s.running)
  const agentBlocks = useBlocksStore((s) => s.agentBlocks)
  return useMemo(() => {
    void running
    void agentBlocks
    return pickTargets({
      workspaces,
      layouts,
      sourceWorkspaceId: workspaceId,
      attention,
      touchedAt,
    }).flatMap((target) => {
      if (!target.sameWorkspace) return []
      const agent = runningAgent(target.paneId)
      return agent ? [{ ...target, title: agentLabel(d, target.title, agent) }] : []
    })
  }, [workspaces, layouts, workspaceId, attention, touchedAt, running, agentBlocks, d])
}

export function useAgentTargets(workspaceId: string): PickTarget[] {
  const d = useDict()
  const local = useLocalAgentTargets(workspaceId)
  const origin = useOriginAgentsStore((s) => s.byWorkspace[workspaceId])
  return useMemo(() => {
    if (!origin) return local
    const remote = origin.targets.map(
      (target): PickTarget => ({
        paneId: target.paneId,
        workspaceId: origin.workspaceId,
        workspaceName: origin.workspaceName,
        title: fmt(d.send.originTarget, {
          agent: agentLabel(d, target.title, target.agent),
          workspace: origin.workspaceName,
        }),
        ...(target.cwd ? { cwd: target.cwd } : {}),
        state: target.state,
        sameWorkspace: false,
        via: workspaceId,
      }),
    )
    return [...local, ...remote]
  }, [local, origin, workspaceId, d])
}

export function useNoAgentsText(workspaceId: string): string {
  const d = useDict()
  const origin = useOriginAgentsStore((s) => s.byWorkspace[workspaceId])
  if (origin === undefined) return d.send.noTargets
  if (origin === null) return d.send.originGone
  return fmt(d.send.noOriginTargets, { workspace: origin.workspaceName })
}

export interface PickSendPanelProps {
  id: string
  summary: string
  noteLabel: string
  notePlaceholder: string
  closeLabel: string
  targets: PickTarget[]
  noTargets: string
  sending: boolean
  onSend: (target: PickTarget, note: string) => void
  onClose: () => void
  secondary?: { label: string; onClick: () => void }
}

export function PickSendPanel({
  id,
  summary,
  noteLabel,
  notePlaceholder,
  closeLabel,
  targets,
  noTargets,
  sending,
  onSend,
  onClose,
  secondary,
}: PickSendPanelProps): JSX.Element {
  const d = useDict()
  const [note, setNote] = useState('')
  const [targetId, setTargetId] = useState<string | null>(targets[0]?.paneId ?? null)
  const panelRef = useRef<HTMLElement | null>(null)
  const target = targets.find((t) => t.paneId === targetId) ?? targets[0] ?? null
  const ids = `send-${id}`

  useEffect(() => {
    panelRef.current?.querySelector('textarea')?.focus()
  }, [])

  const submit = (): void => {
    if (target && !sending) onSend(target, note)
  }

  const onPanelKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <section
      ref={panelRef}
      aria-label={d.send.title}
      className="motion-enter absolute top-10 right-2 z-10 flex origin-top-right w-80 flex-col gap-2 rounded-md border border-line bg-surface-3 p-3 text-fg text-ui-sm shadow-md"
      onKeyDown={onPanelKeyDown}
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 font-medium text-ui-sm">{d.send.title}</span>
        <IconButton icon={XIcon} label={closeLabel} onClick={onClose} />
      </div>
      <code className="truncate font-mono text-fg-muted text-ui-xs">{summary}</code>
      <Label htmlFor={`${ids}-note`} className="font-normal text-fg-muted text-ui-xs">
        {noteLabel}
      </Label>
      <Textarea
        id={`${ids}-note`}
        value={note}
        placeholder={notePlaceholder}
        onChange={(e) => setNote(e.target.value)}
        className="min-h-16 text-ui-sm"
      />
      <fieldset className="flex min-w-0 flex-col gap-1">
        <legend className="mb-1 text-fg-muted text-ui-xs">{d.send.target}</legend>
        {targets.length === 0 ? (
          <p className="text-fg-muted">{noTargets}</p>
        ) : (
          <RadioGroup
            aria-label={d.send.target}
            value={target?.paneId ?? null}
            onValueChange={(value) => setTargetId(value as string)}
            className="flex max-h-40 flex-col gap-0 overflow-y-auto"
          >
            {targets.map((t) => {
              const checked = t.paneId === target?.paneId
              return (
                <label
                  key={t.paneId}
                  htmlFor={`${ids}-target-${t.paneId}`}
                  className="flex items-center gap-2 rounded-sm px-2 py-1 hover:bg-surface-2 has-data-checked:bg-surface-2"
                >
                  <RadioGroupItem id={`${ids}-target-${t.paneId}`} value={t.paneId} />
                  <span
                    className={`dot ${t.state === 'none' ? '' : t.state}`}
                    role="img"
                    aria-label={stateLabel(d, t.state)}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={checked ? 'truncate font-medium' : 'truncate'}>
                      {t.sameWorkspace || t.via ? t.title : `${t.workspaceName} · ${t.title}`}
                    </span>
                    {t.cwd ? (
                      <span className="truncate font-mono text-fg-muted text-ui-xs">{t.cwd}</span>
                    ) : null}
                  </span>
                </label>
              )
            })}
          </RadioGroup>
        )}
      </fieldset>
      <div className="flex justify-end gap-2">
        {secondary ? (
          <Button size="sm" variant="outline" disabled={sending} onClick={secondary.onClick}>
            {secondary.label}
          </Button>
        ) : null}
        <Button size="sm" disabled={!target || sending} onClick={submit}>
          {d.send.send}
        </Button>
      </div>
    </section>
  )
}
