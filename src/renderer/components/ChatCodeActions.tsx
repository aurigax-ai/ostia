import {
  BookmarkSimpleIcon,
  CheckIcon,
  CopyIcon,
  FloppyDiskIcon,
  PaperPlaneTiltIcon,
  PlayIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react'
import { useEffect, useId, useMemo, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import {
  type TerminalTarget,
  insertInto,
  runConfirmed,
  runInNewTerminal,
  saveCodeAsFile,
  sendToAgent,
  workspaceTerminals,
} from '../lib/chatActions'
import { confirmsGeneratedText } from '../lib/pasteGate'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useWorkflowsStore } from '../stores/workflowsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { IconButton } from './IconButton'
import { DropdownMenu, MenuItem, MenuLabel } from './Menu'
import { useAgentTargets } from './PickSendPanel'
import { RiskyPasteDialog } from './RiskyPasteDialog'
import { Button } from './ui/button'
import { ContextMenuGroup } from './ui/context-menu'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from './ui/popover'

export type ChatActionNotice =
  | 'inserted'
  | 'copiedInstead'
  | 'sentToAgent'
  | 'agentNotReady'
  | 'ranInTerminal'
  | 'runFailed'
  | 'savedFile'
  | 'saveFileFailed'

export interface CodeActionsProps {
  code: string
  language: string
  shell: boolean
  sessionId: string
  workspaceId: string | null
  onNotice: (notice: ChatActionNotice) => void
  onInserted?: () => void
}

export function useCopied(): [boolean, () => void] {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return [copied, () => setCopied(true)]
}

export function CopyCodeButton({ code }: { code: string }): JSX.Element {
  const d = useDict()
  const [copied, setCopied] = useCopied()
  return (
    <IconButton
      icon={copied ? CheckIcon : CopyIcon}
      label={copied ? d.ask.copied : d.ask.copy}
      onClick={() => {
        void navigator.clipboard?.writeText(code).then(setCopied, () => undefined)
      }}
    />
  )
}

export function ChatCodeActions(props: CodeActionsProps): JSX.Element {
  const d = useDict()
  const { code, language, shell } = props
  return (
    <>
      <CopyCodeButton code={code} />
      {shell ? <InsertAction {...props} /> : null}
      {shell ? <RunAction {...props} /> : null}
      {props.workspaceId ? <AgentAction {...props} workspaceId={props.workspaceId} /> : null}
      {language ? (
        <IconButton
          icon={FloppyDiskIcon}
          label={d.chatActions.saveFile}
          onClick={() => {
            void saveCodeAsFile(code, language).then((outcome) => {
              if (outcome === 'saved') props.onNotice('savedFile')
              else if (outcome === 'failed') props.onNotice('saveFileFailed')
            })
          }}
        />
      ) : null}
      {shell ? (
        <IconButton
          icon={BookmarkSimpleIcon}
          label={d.chatActions.saveWorkflow}
          onClick={() => useWorkflowsStore.getState().startSave(code.trim())}
        />
      ) : null}
    </>
  )
}

export function useTerminals(workspaceId: string | null): TerminalTarget[] {
  const drafts = useBlocksStore((s) => s.drafts)
  const running = useBlocksStore((s) => s.running)
  const layouts = useLayoutStore((s) => s.byWorkspace)
  return useMemo(() => {
    void layouts
    return workspaceTerminals(workspaceId, { drafts, running })
  }, [workspaceId, drafts, running, layouts])
}

export function insertReason(
  d: ReturnType<typeof useDict>,
  terminals: TerminalTarget[],
): string | null {
  if (terminals.length === 0) return d.chat.insertNoTerminal
  return terminals.some((t) => t.idle) ? null : d.chat.insertBusy
}

function InsertAction({ code, workspaceId, onNotice, onInserted }: CodeActionsProps): JSX.Element {
  const d = useDict()
  const terminals = useTerminals(workspaceId)
  const reason = insertReason(d, terminals)
  const reasonId = useId()
  const insert = (paneId: string): void => {
    if (insertInto(paneId, code)) {
      onNotice('inserted')
      onInserted?.()
    } else {
      void navigator.clipboard?.writeText(code.trim()).catch(() => undefined)
      onNotice('copiedInstead')
    }
  }
  if (terminals.length > 1 && reason === null) {
    return (
      <DropdownMenu trigger={<IconButton icon={TerminalWindowIcon} label={d.ask.insert} />}>
        <ContextMenuGroup>
          <MenuLabel>{d.chatActions.insertInto}</MenuLabel>
          {terminals.map((t) => (
            <MenuItem
              key={t.paneId}
              icon={TerminalWindowIcon}
              disabled={!t.idle}
              hint={t.idle ? undefined : d.chatActions.busy}
              onClick={() => insert(t.paneId)}
            >
              {t.title}
            </MenuItem>
          ))}
        </ContextMenuGroup>
      </DropdownMenu>
    )
  }
  return (
    <>
      <IconButton
        icon={TerminalWindowIcon}
        label={reason ? `${d.ask.insert} (${reason})` : d.ask.insert}
        aria-disabled={reason !== null}
        aria-describedby={reason ? reasonId : undefined}
        className="aria-disabled:opacity-50"
        onClick={() => {
          const target = terminals.find((t) => t.idle)
          if (reason === null && target) insert(target.paneId)
        }}
      />
      {reason ? (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      ) : null}
    </>
  )
}

function RunAction({ code, sessionId, workspaceId, onNotice }: CodeActionsProps): JSX.Element {
  const d = useDict()
  const [confirming, setConfirming] = useState(false)
  const [risky, setRisky] = useState<string | null>(null)
  const folder = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === (workspaceId ?? s.activeWorkspaceId))?.workDir ?? '',
  )
  const command = code.trim()
  const run = (): void => {
    setConfirming(false)
    setRisky(null)
    runConfirmed.add(sessionId)
    onNotice(runInNewTerminal(workspaceId, command) ? 'ranInTerminal' : 'runFailed')
  }
  const start = (): void => {
    if (confirmsGeneratedText(command)) setRisky(command)
    else if (runConfirmed.has(sessionId)) run()
    else setConfirming(true)
  }
  return (
    <>
      <Popover
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false)
          else start()
        }}
      >
        <PopoverTrigger render={<IconButton icon={PlayIcon} label={d.chatActions.run} />} />
        <PopoverContent side="bottom" align="end" className="w-80">
          <PopoverTitle className="text-fg text-ui-sm">{d.chatActions.runTitle}</PopoverTitle>
          <PopoverDescription className="text-fg-muted text-ui-xs">
            {fmt(d.chatActions.runBody, { folder })}
          </PopoverDescription>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-line bg-surface-1 p-2 font-mono text-fg text-ui-sm">
            {command}
          </pre>
          <div className="flex justify-end gap-1.5">
            <Button variant="outline" size="sm" onClick={() => setConfirming(false)}>
              {d.chatActions.cancel}
            </Button>
            <Button size="sm" onClick={run}>
              {d.chatActions.runConfirm}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <RiskyPasteDialog
        text={risky}
        source="generated"
        onPaste={run}
        onCancel={() => setRisky(null)}
      />
    </>
  )
}

function AgentAction({
  code,
  workspaceId,
  onNotice,
}: CodeActionsProps & { workspaceId: string }): JSX.Element | null {
  const d = useDict()
  const targets = useAgentTargets(workspaceId)
  if (targets.length === 0) return null
  return (
    <DropdownMenu
      trigger={<IconButton icon={PaperPlaneTiltIcon} label={d.chatActions.sendToAgent} />}
    >
      <ContextMenuGroup>
        <MenuLabel>{d.chatActions.sendToAgent}</MenuLabel>
        {targets.map((t) => (
          <MenuItem
            key={t.paneId}
            leading={<span className={`dot ${t.state === 'none' ? '' : t.state}`} />}
            onClick={() => {
              void sendToAgent(t, code.trim()).then((sent) => {
                if (!sent) void navigator.clipboard?.writeText(code.trim()).catch(() => undefined)
                onNotice(sent ? 'sentToAgent' : 'agentNotReady')
              })
            }}
          >
            {t.title}
          </MenuItem>
        ))}
      </ContextMenuGroup>
    </DropdownMenu>
  )
}
