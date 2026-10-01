import { isBuiltinChatTool, mcpToolName } from '@shared/chatTools'
import { structuredPatch } from 'diff'
import { useMemo, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import type { ApprovalAnswer } from '../lib/chatToolPermissions'
import { workspaceFolder } from '../lib/chatTools'
import { type ToolPartLike, outputText, toolNameOf } from '../lib/chatTransport'
import { confirmsGeneratedText } from '../lib/pasteGate'
import { type PendingApproval, answerApproval, useChatToolsStore } from '../stores/chatToolsStore'
import { RiskyPasteDialog } from './RiskyPasteDialog'
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationTitle,
} from './ai-elements/confirmation'
import {
  ToolSection as Section,
  Tool,
  ToolContent,
  ToolHeader,
  type ToolState,
} from './ai-elements/tool'

const DIFF_LINES_MAX = 400
const SHOWN_OUTPUT_MAX = 4000

export function toolTitle(d: ReturnType<typeof useDict>, name: string): string {
  if (isBuiltinChatTool(name)) return d.chatTools.names[name]
  for (const server of useChatToolsStore.getState().mcp) {
    const tool = server.tools.find((t) => mcpToolName(server.name, t.name) === name)
    if (tool) return `${server.name} · ${tool.name}`
  }
  return name
}

interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk'
  text: string
}

export function diffLines(before: string, after: string): DiffLine[] {
  const patch = structuredPatch('a', 'b', before, after, undefined, undefined, { context: 3 })
  const out: DiffLine[] = []
  for (const hunk of patch.hunks) {
    out.push({
      kind: 'hunk',
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    })
    for (const line of hunk.lines) {
      if (line.startsWith('\\')) continue
      const kind = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx'
      out.push({ kind, text: line })
    }
  }
  return out
}

const DIFF_TONES: Record<DiffLine['kind'], string> = {
  add: 'text-add',
  del: 'text-del',
  ctx: 'text-fg-muted',
  hunk: 'text-fg-muted',
}

function WriteDiff({ before, after }: { before: string; after: string }): JSX.Element {
  const d = useDict()
  const lines = useMemo(() => diffLines(before, after), [before, after])
  if (lines.length === 0) return <p className="text-fg-muted text-ui-xs">{d.chatTools.diffSame}</p>
  const shown = lines.slice(0, DIFF_LINES_MAX)
  return (
    <div className="flex flex-col gap-1">
      <pre
        aria-label="diff"
        className="max-h-72 overflow-auto rounded-sm bg-bg-sunken p-2 font-mono text-ui-xs"
      >
        {shown.map((line, i) => (
          <div key={`${i}-${line.kind}`} className={DIFF_TONES[line.kind]} data-diff={line.kind}>
            {line.text || ' '}
          </div>
        ))}
      </pre>
      {lines.length > shown.length ? (
        <p className="text-fg-muted text-ui-xs">
          {fmt(d.chatTools.diffMore, { count: lines.length - shown.length })}
        </p>
      ) : null}
    </div>
  )
}

function approvalTitle(
  d: ReturnType<typeof useDict>,
  pending: PendingApproval,
  workspaceId: string | null,
): string {
  const t = d.chatTools
  const { detail } = pending
  switch (pending.kind) {
    case 'read-outside':
      return fmt(t.askReadOutside, { path: detail.path ?? '' })
    case 'write':
      return fmt(detail.exists ? t.askWrite : t.askWriteNew, { path: detail.path ?? '' })
    case 'command':
      return fmt(t.askCommand, { folder: workspaceFolder(workspaceId) })
    case 'mcp':
      return fmt(t.askMcp, { tool: detail.tool ?? '', server: detail.server ?? '' })
    default:
      return detail.url
        ? fmt(t.askOpenUrl, { url: detail.url })
        : fmt(t.askOpenFile, { path: detail.path ?? '' })
  }
}

function ApprovalCard({
  pending,
  workspaceId,
}: {
  pending: PendingApproval
  workspaceId: string | null
}): JSX.Element {
  const d = useDict()
  const t = d.chatTools
  const [risky, setRisky] = useState<string | null>(null)
  const answer = (a: ApprovalAnswer): void => answerApproval(pending.toolCallId, a)
  const { detail } = pending
  return (
    <Confirmation aria-label={t.states['approval-requested']} className="chat-tool-approval">
      <ConfirmationTitle>{approvalTitle(d, pending, workspaceId)}</ConfirmationTitle>
      {pending.kind === 'command' && detail.command ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-bg-sunken p-2 font-mono text-fg text-ui-sm">
          {detail.command}
        </pre>
      ) : null}
      {pending.kind === 'write' ? (
        <WriteDiff before={detail.before ?? ''} after={detail.after ?? ''} />
      ) : null}
      {pending.kind === 'mcp' ? (
        <Section label={t.input} code={JSON.stringify(pending.input, null, 2)} />
      ) : null}
      <ConfirmationActions>
        <ConfirmationAction variant="outline" onClick={() => answer({ approved: false })}>
          {t.deny}
        </ConfirmationAction>
        {pending.kind === 'command' ? (
          <>
            <ConfirmationAction
              variant="outline"
              onClick={() => answer({ approved: true, scope: 'once', choice: 'insert' })}
            >
              {t.insert}
            </ConfirmationAction>
            <ConfirmationAction
              onClick={() => {
                const command = detail.command ?? ''
                if (confirmsGeneratedText(command)) setRisky(command)
                else answer({ approved: true, scope: 'once', choice: 'run' })
              }}
            >
              {t.runNew}
            </ConfirmationAction>
          </>
        ) : (
          <>
            {pending.grantable ? (
              <ConfirmationAction
                variant="outline"
                onClick={() => answer({ approved: true, scope: 'chat' })}
              >
                {t.allowChat}
              </ConfirmationAction>
            ) : null}
            <ConfirmationAction onClick={() => answer({ approved: true, scope: 'once' })}>
              {t.allowOnce}
            </ConfirmationAction>
          </>
        )}
      </ConfirmationActions>
      <RiskyPasteDialog
        text={risky}
        source="generated"
        onPaste={() => {
          setRisky(null)
          answer({ approved: true, scope: 'once', choice: 'run' })
        }}
        onCancel={() => setRisky(null)}
      />
    </Confirmation>
  )
}

function shownState(part: ToolPartLike, pending: boolean, busy: boolean): ToolState | 'stopped' {
  if (pending) return 'approval-requested'
  const state = part.state as ToolState
  const unresolved =
    state === 'input-streaming' ||
    state === 'input-available' ||
    state === 'approval-requested' ||
    state === 'approval-responded'
  return unresolved && !busy ? 'stopped' : state
}

export function ChatToolPart({
  part,
  workspaceId,
  busy,
}: {
  part: ToolPartLike
  workspaceId: string | null
  busy: boolean
}): JSX.Element {
  const d = useDict()
  const t = d.chatTools
  const pending = useChatToolsStore((s) => s.pending[part.toolCallId])
  const [open, setOpen] = useState(false)
  const name = toolNameOf(part)
  const state = shownState(part, pending !== undefined, busy)
  const headerState: ToolState = state === 'stopped' ? 'output-denied' : state
  const label = state === 'stopped' ? t.stopped : t.states[state]
  const input =
    part.input && typeof part.input === 'object' && Object.keys(part.input).length > 0
      ? JSON.stringify(part.input, null, 2)
      : ''
  const output = part.state === 'output-available' ? outputText(part.output, SHOWN_OUTPUT_MAX) : ''
  return (
    <Tool
      open={open}
      onOpenChange={setOpen}
      className="chat-tool"
      data-tool={name}
      data-state={state}
    >
      <ToolHeader title={toolTitle(d, name)} state={headerState} stateLabel={label} />
      {pending ? (
        <div className="px-2 pb-2">
          <ApprovalCard pending={pending} workspaceId={workspaceId} />
        </div>
      ) : null}
      <ToolContent>
        {input ? <Section label={t.input} code={input} /> : null}
        {output ? <Section label={t.output} code={output} /> : null}
        {part.state === 'output-error' && part.errorText ? (
          <Section label={t.error} code={part.errorText} tone="error" />
        ) : null}
      </ToolContent>
    </Tool>
  )
}
