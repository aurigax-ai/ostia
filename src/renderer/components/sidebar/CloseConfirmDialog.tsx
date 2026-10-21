import {
  FileDashedIcon,
  FlaskIcon,
  QuestionIcon,
  RobotIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import { ListRow } from '@/components/common/ListRow'
import { TextLink } from '@/components/common/TextLink'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { fmt, useDict } from '@/lib/app/useDict'
import { baseName } from '@/lib/files/fileTree'
import { keptRunning, type QuitLosses, quitLosses } from '@/lib/workspaces/closeConfirm'
import {
  type CloseConfirmKind,
  type RunningGroup,
  useCloseConfirmStore,
} from '@/stores/workspaces/closeConfirmStore'

const WRAP = 'block min-w-0 whitespace-normal [overflow-wrap:anywhere]'

function confirmCopy(d: Dict): Record<CloseConfirmKind, ConfirmCopy> {
  return {
    workspace: {
      title: d.closeConfirm.workspaceTitle,
      body: d.closeConfirm.workspaceBody,
      action: d.closeConfirm.workspaceAction,
    },
    pane: {
      title: d.closeConfirm.paneTitle,
      body: d.closeConfirm.paneBody,
      action: d.closeConfirm.paneAction,
    },
    quit: {
      title: d.closeConfirm.quitTitle,
      body: d.closeConfirm.quitBody,
      action: d.closeConfirm.quitAction,
    },
    move: {
      title: d.closeConfirm.moveTitle,
      body: d.closeConfirm.moveBody,
      action: d.closeConfirm.moveAction,
    },
  }
}

function RunningGroupItem({ group }: { group: RunningGroup }): JSX.Element {
  const d = useDict()
  return (
    <li>
      <div className="min-w-0 font-medium text-fg text-ui-base [overflow-wrap:anywhere]">
        {group.workspace}
      </div>
      <ul className="mt-1 flex flex-col gap-1">
        {group.commands.map((command, index) => (
          <ListRow
            // biome-ignore lint/suspicious/noArrayIndexKey: commands can repeat and never reorder while the dialog is open
            key={index}
            density="dense"
            lead={<TerminalWindowIcon size={16} aria-hidden />}
            title={
              <span className={`${WRAP} font-mono`}>
                {command || d.closeConfirm.unknownCommand}
              </span>
            }
          />
        ))}
        {group.agents?.map((agent, index) => (
          <ListRow
            // biome-ignore lint/suspicious/noArrayIndexKey: agents can repeat and never reorder while the dialog is open
            key={index}
            density="dense"
            lead={<RobotIcon size={16} aria-hidden />}
            title={
              <span className={`${WRAP} font-mono`}>{agent || d.closeConfirm.unknownCommand}</span>
            }
          />
        ))}
        {group.scratchFiles ? (
          <ListRow
            density="dense"
            lead={<FlaskIcon size={16} aria-hidden />}
            title={
              <span className={WRAP}>
                {group.scratchFiles === 1
                  ? d.closeConfirm.scratchFilesOne
                  : fmt(d.closeConfirm.scratchFiles, { count: group.scratchFiles })}
              </span>
            }
            meta={
              <TextLink
                size="xs"
                className="h-5 px-1 text-ui-sm"
                onClick={() => window.ostia.scratch.reveal(group.workspaceId)}
              >
                {d.closeConfirm.reveal}
              </TextLink>
            }
          />
        ) : null}
        {group.files.map((file) => (
          <ListRow
            key={file}
            density="dense"
            lead={<FileDashedIcon size={16} aria-hidden />}
            title={
              <span className={WRAP}>{fmt(d.closeConfirm.unsaved, { file: baseName(file) })}</span>
            }
          />
        ))}
        {group.unanswered ? (
          <ListRow
            density="dense"
            lead={<QuestionIcon size={16} aria-hidden />}
            title={<span className={WRAP}>{d.closeConfirm.unanswered}</span>}
          />
        ) : null}
      </ul>
    </li>
  )
}

function KeptShellsSection({
  keptShells,
  keptActivity,
  showBody,
}: {
  keptShells: Parameters<typeof keptRunning>[0]
  keptActivity: Parameters<typeof keptRunning>[1]
  showBody: boolean
}): JSX.Element {
  const d = useDict()
  const { agents, commands } = keptRunning(keptShells, keptActivity)
  return (
    <section aria-label={d.closeConfirm.keptTitle} className="flex flex-col gap-1">
      <div className="font-medium text-fg text-ui-sm">
        {keptShells.length === 1
          ? d.closeConfirm.keptShellsOne
          : fmt(d.closeConfirm.keptShells, { count: keptShells.length })}
      </div>
      <ul className="flex flex-col gap-1">
        {agents.map((agent, index) => (
          <ListRow
            // biome-ignore lint/suspicious/noArrayIndexKey: agents can repeat and never reorder while the dialog is open
            key={`agent-${index}`}
            density="dense"
            lead={<RobotIcon size={16} aria-hidden />}
            title={
              <span className={`${WRAP} font-mono`}>{agent || d.closeConfirm.unknownCommand}</span>
            }
          />
        ))}
        {commands.map((command, index) => (
          <ListRow
            // biome-ignore lint/suspicious/noArrayIndexKey: commands can repeat and never reorder while the dialog is open
            key={`command-${index}`}
            density="dense"
            lead={<TerminalWindowIcon size={16} aria-hidden />}
            title={
              <span className={`${WRAP} font-mono`}>
                {command || d.closeConfirm.unknownCommand}
              </span>
            }
          />
        ))}
      </ul>
      {showBody ? <p className="text-fg-muted text-ui-sm">{d.closeConfirm.keptBody}</p> : null}
    </section>
  )
}

export function CloseConfirmDialog(): JSX.Element {
  const d = useDict()
  const pending = useCloseConfirmStore((s) => s.pending)
  const answer = useCloseConfirmStore((s) => s.answer)
  const keepShells = useCloseConfirmStore((s) => s.keepShells)
  const keptShells = pending?.kind === 'quit' ? pending.keptShells : []
  const offersKeep = keptShells.length > 0

  const copy = confirmCopy(d)
  const text = withKept(
    d,
    withScratch(d, pending?.kind ?? 'workspace', pending?.groups ?? [], copy),
    offersKeep && (pending?.groups.length ?? 0) === 0,
  )

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) answer(false)
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto]"
      >
        <DialogHeader>
          <DialogTitle>{text.title}</DialogTitle>
          <DialogDescription>{text.body}</DialogDescription>
        </DialogHeader>
        <div data-slot="close-confirm-body" className="flex min-h-0 flex-col gap-4 overflow-auto">
          {pending?.kind === 'quit' && pending.groups.length > 0 ? (
            <ul aria-label={text.body} className="flex flex-col gap-1">
              {lossLines(d, quitLosses(pending.groups)).map((line) => (
                <li key={line} className="font-medium text-fg text-ui-sm">
                  {line}
                </li>
              ))}
            </ul>
          ) : null}
          <ul aria-label={text.title} className="flex flex-col gap-2">
            {pending?.groups.map((group) => (
              <RunningGroupItem key={group.workspaceId} group={group} />
            ))}
          </ul>
          {offersKeep ? (
            <KeptShellsSection
              keptShells={keptShells}
              keptActivity={pending?.keptActivity}
              showBody={Boolean(pending?.groups.length)}
            />
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => answer(false)}>
            {d.closeConfirm.cancel}
          </Button>
          <Button variant="destructive" size="sm" onClick={() => answer(true)}>
            {offersKeep ? d.closeConfirm.endAction : text.action}
          </Button>
          {offersKeep ? (
            <Button size="sm" autoFocus onClick={keepShells}>
              {d.closeConfirm.keepAction}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface ConfirmCopy {
  title: string
  body: string
  action: string
}

function withScratch(
  d: Dict,
  kind: CloseConfirmKind,
  groups: readonly RunningGroup[],
  copy: Record<CloseConfirmKind, ConfirmCopy>,
): ConfirmCopy {
  const count = groups.reduce((sum, g) => sum + (g.scratchFiles ?? 0), 0)
  const onlyScratch = groups.every(
    (g) => g.commands.length === 0 && !g.agents?.length && g.files.length === 0 && !g.unanswered,
  )
  if (count === 0 || !onlyScratch) return copy[kind]
  return {
    title:
      count === 1 ? d.closeConfirm.scratchTitleOne : fmt(d.closeConfirm.scratchTitle, { count }),
    body: d.closeConfirm.scratchBody,
    action: kind === 'quit' ? copy.quit.action : d.closeConfirm.scratchAction,
  }
}

function withKept(d: Dict, text: ConfirmCopy, onlyKept: boolean): ConfirmCopy {
  if (!onlyKept) return text
  return { ...text, title: d.closeConfirm.keptTitle, body: d.closeConfirm.keptBody }
}

function lossLines(d: Dict, losses: QuitLosses): string[] {
  const c = d.closeConfirm
  const line = (count: number, one: string, many: string): string[] =>
    count === 0 ? [] : [count === 1 ? one : fmt(many, { count })]
  return [
    ...line(losses.processes, c.lostProcessesOne, c.lostProcesses),
    ...line(losses.agents, c.lostAgentsOne, c.lostAgents),
    ...line(losses.files, c.lostFilesOne, c.lostFiles),
    ...line(losses.scratchFiles, c.lostScratchOne, c.lostScratch),
  ]
}
