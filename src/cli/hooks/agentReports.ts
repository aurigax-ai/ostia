import type { MessageConnection } from 'vscode-jsonrpc/node'
import { capturedArgs } from '../../shared/agents/agentLaunch'
import {
  isResumableAgent,
  RESUMABLE_AGENTS,
  resumeFromHookPayload,
} from '../../shared/agents/agentResume'
import {
  CLAUDE_WORK_EVENTS,
  claudeWorkReport,
  isClaudeWorkEvent,
} from '../../shared/agents/agentWork'
import {
  CLAUDE_ATTENTION_EVENTS,
  claudeAttention,
  isClaudeAttentionEvent,
} from '../../shared/agents/claudeAttention'
import {
  CODEX_ATTENTION_EVENTS,
  codexAttention,
  isCodexAttentionEvent,
} from '../../shared/agents/codexAttention'
import { isTurnHookEvent, TURN_HOOK_EVENTS, turnReportOf } from '../../shared/agents/turnHook'
import { fail } from '../common/failure'
import { readAllStdin } from '../common/stdinText'

export async function runClaudeHookVerb(conn: MessageConnection): Promise<void> {
  const event = process.argv[3]
  if (!isClaudeAttentionEvent(event) && !isClaudeWorkEvent(event)) {
    const events = [...new Set([...CLAUDE_ATTENTION_EVENTS, ...CLAUDE_WORK_EVENTS])]
    fail(`ostia claude-hook: usage: claude-hook <${events.join('|')}>`)
    return
  }
  const input = await readAllStdin()
  if (isClaudeWorkEvent(event)) {
    await conn.sendRequest('pane.reportWork', claudeWorkReport(event, input))
  }
  const attention = isClaudeAttentionEvent(event) ? claudeAttention(event, input) : null
  if (!attention) return
  const res = await conn.sendRequest<{ ok: boolean; error?: string }>('pane.setAttention', {
    state: attention.state,
    message: attention.message || undefined,
    closing: attention.closing,
    soft: attention.soft,
  })
  if (!res.ok) {
    fail(`ostia claude-hook: ${res.error ?? 'failed'}`)
  }
}

export async function runCodexHookVerb(conn: MessageConnection): Promise<void> {
  const event = process.argv[3]
  if (!isCodexAttentionEvent(event)) {
    fail(`ostia codex-hook: usage: codex-hook <${CODEX_ATTENTION_EVENTS.join('|')}>`)
    return
  }
  const attention = codexAttention(event, await readAllStdin())
  if (!attention) return
  const res = await conn.sendRequest<{ ok: boolean; error?: string }>('pane.setAttention', {
    state: attention.state,
    message: attention.message || undefined,
  })
  if (!res.ok) {
    fail(`ostia codex-hook: ${res.error ?? 'failed'}`)
  }
}

const TURN_HOOK_INPUT_MAX = 4 * 1024 * 1024

export async function runTurnHookVerb(conn: MessageConnection): Promise<void> {
  const event = process.argv[3]
  if (!isTurnHookEvent(event)) {
    fail(`ostia turn-hook: usage: turn-hook <${TURN_HOOK_EVENTS.join('|')}>`)
    return
  }
  const input = await readAllStdin()
  if (input.length > TURN_HOOK_INPUT_MAX) return
  const report = turnReportOf(event, input)
  if (report) await conn.sendRequest('pane.reportTurn', report)
}

export async function runResumeTokenVerb(conn: MessageConnection): Promise<void> {
  const [agent, raw, mode] = process.argv.slice(3)
  if (!isResumableAgent(agent) || !raw || (mode !== undefined && mode !== 'folder')) {
    fail(`ostia resume-token: usage: resume-token <${RESUMABLE_AGENTS.join('|')}> <id|-> [folder]`)
    return
  }
  const id = resumeFromHookPayload(raw === '-' ? await readAllStdin() : raw)
  if (!id) {
    fail('ostia resume-token: no agent session id found')
    return
  }
  const args = capturedArgs(agent, process.env)
  const res = await conn.sendRequest<{ ok: boolean; error?: string }>(
    mode === 'folder' ? 'pane.setResumeFolder' : 'pane.setResume',
    { agent, id, ...(args && mode !== 'folder' ? { args } : {}) },
  )
  if (res.ok) {
    console.log('ok')
  } else {
    fail(`ostia resume-token: ${res.error ?? 'failed'}`)
  }
}
