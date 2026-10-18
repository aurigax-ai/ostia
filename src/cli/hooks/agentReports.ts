import type { MessageConnection } from 'vscode-jsonrpc/node'
import { capturedArgs } from '../../shared/agents/agentLaunch'
import {
  RESUMABLE_AGENTS,
  isResumableAgent,
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
import { readAllStdin } from '../common/stdinText'

export async function runClaudeHookVerb(conn: MessageConnection): Promise<void> {
  const event = process.argv[3]
  if (!isClaudeAttentionEvent(event) && !isClaudeWorkEvent(event)) {
    const events = [...new Set([...CLAUDE_ATTENTION_EVENTS, ...CLAUDE_WORK_EVENTS])]
    console.error(`ostia claude-hook: usage: claude-hook <${events.join('|')}>`)
    process.exitCode = 1
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
  })
  if (!res.ok) {
    console.error(`ostia claude-hook: ${res.error ?? 'failed'}`)
    process.exitCode = 1
  }
}

export async function runResumeTokenVerb(conn: MessageConnection): Promise<void> {
  const [agent, raw] = process.argv.slice(3)
  if (!isResumableAgent(agent) || !raw) {
    console.error(`ostia resume-token: usage: resume-token <${RESUMABLE_AGENTS.join('|')}> <id|->`)
    process.exitCode = 1
    return
  }
  const id = resumeFromHookPayload(raw === '-' ? await readAllStdin() : raw)
  if (!id) {
    console.error('ostia resume-token: no agent session id found')
    process.exitCode = 1
    return
  }
  const args = capturedArgs(agent, process.env)
  const res = await conn.sendRequest<{ ok: boolean; error?: string }>('pane.setResume', {
    agent,
    id,
    ...(args ? { args } : {}),
  })
  if (res.ok) {
    console.log('ok')
  } else {
    console.error(`ostia resume-token: ${res.error ?? 'failed'}`)
    process.exitCode = 1
  }
}
