import type { AgentEvent, AgentToolReply } from '@aurigax-ai/ostia-extension-sdk/contract/agent'
import type { AgentToolCallNotice } from '@shared/agent/agentApi'
import type { ChatTransport, UIMessageChunk } from 'ai'
import { agentProblem } from '@/lib/agent/agentProblem'
import { agentPromptText } from '@/lib/agent/agentPrompt'
import type { ChatToolDef, ToolOutcome, ToolRun } from '@/lib/assist/chatToolGate'
import { type OstiaChatMessage, outputText } from '@/lib/assist/chatTransport'

const AGENT_DENIED_TEXT = 'The human denied this call.'

export interface AgentTransportSession {
  sessionId: string
  workspaceId: () => string | null
  root: () => string
  tools: () => ChatToolDef[]
  prepare: () => Promise<string | null>
}

function replyOf(outcome: ToolOutcome): AgentToolReply {
  if (outcome.state === 'done') return { ok: true, output: outputText(outcome.output) }
  if (outcome.state === 'denied') return { ok: false, error: AGENT_DENIED_TEXT, denied: true }
  return { ok: false, error: outcome.error }
}

function failureText(message: string): string {
  return `failed\n${message}`
}

export function createAgentTransport(
  session: AgentTransportSession,
): ChatTransport<OstiaChatMessage> {
  return {
    sendMessages: async ({ messages, abortSignal }) => {
      const last = messages[messages.length - 1]
      const api = window.ostia.agentSessions
      return new ReadableStream<UIMessageChunk>({
        start: async (controller) => {
          let closed = false
          let started = false
          let textId: string | null = null
          let textSeq = 0
          const running = new Map<string, AbortController>()
          const subscriptions: (() => void)[] = []
          const emit = (chunk: UIMessageChunk): void => {
            if (closed) return
            try {
              controller.enqueue(chunk)
            } catch {
              closed = true
            }
          }
          const begin = (): void => {
            if (started) return
            started = true
            emit({ type: 'start', messageMetadata: { createdAt: Date.now() } })
          }
          const closeText = (): void => {
            if (textId === null) return
            emit({ type: 'text-end', id: textId })
            textId = null
          }
          const finish = (): void => {
            if (closed) return
            closeText()
            begin()
            emit({ type: 'finish' })
            closed = true
            for (const stop of subscriptions) stop()
            try {
              controller.close()
            } catch {}
          }
          const fail = (message: string): void => {
            begin()
            emit({ type: 'error', errorText: failureText(message) })
            finish()
          }
          const onEvent = (event: AgentEvent): void => {
            if (event.type === 'text-delta') {
              begin()
              if (textId === null) {
                textSeq += 1
                textId = `answer${textSeq}`
                emit({ type: 'text-start', id: textId })
              }
              emit({ type: 'text-delta', id: textId, delta: event.text })
            } else if (event.type === 'tool-call') {
              begin()
              closeText()
              emit({
                type: 'tool-input-available',
                toolCallId: event.toolCallId,
                toolName: event.name,
                input: event.input,
              })
            } else if (event.type === 'error') {
              begin()
              emit({ type: 'error', errorText: failureText(event.message) })
            } else if (event.type === 'turn-end') {
              finish()
            }
          }
          const runTool = async (call: AgentToolCallNotice): Promise<void> => {
            const def = session.tools().find((d) => d.spec.name === call.name)
            const abort = new AbortController()
            running.set(call.callId, abort)
            let outcome: ToolOutcome
            if (!def) outcome = { state: 'error', error: `Unknown tool ${call.name}.` }
            else {
              const run: ToolRun = {
                sessionId: session.sessionId,
                workspaceId: session.workspaceId(),
                root: session.root(),
                callId: call.callId,
                toolCallId: call.toolCallId,
                signal: abort.signal,
                onApproval: (approvalId) =>
                  emit({ type: 'tool-approval-request', approvalId, toolCallId: call.toolCallId }),
                onAnswer: (approvalId, approved) =>
                  emit({ type: 'tool-approval-response', approvalId, approved }),
              }
              try {
                outcome = await def.run(call.input, run)
              } catch (err) {
                outcome = {
                  state: 'error',
                  error: err instanceof Error ? err.message : String(err),
                }
              }
            }
            running.delete(call.callId)
            if (outcome.state === 'done') {
              emit({
                type: 'tool-output-available',
                toolCallId: call.toolCallId,
                output: outcome.output as never,
              })
            } else if (outcome.state === 'denied') {
              emit({ type: 'tool-output-denied', toolCallId: call.toolCallId })
            } else {
              emit({
                type: 'tool-output-error',
                toolCallId: call.toolCallId,
                errorText: outcome.error,
              })
            }
            api.answerTool(call.callId, replyOf(outcome))
          }
          subscriptions.push(
            api.onEvent((notice) => {
              if (notice.sessionId === session.sessionId) onEvent(notice.event)
            }),
            api.onToolCall((call) => {
              if (call.sessionId === session.sessionId) void runTool(call)
            }),
            api.onToolCancel(({ callId }) => running.get(callId)?.abort()),
          )
          abortSignal?.addEventListener(
            'abort',
            () => {
              void api.abort(session.sessionId)
              finish()
            },
            { once: true },
          )
          const problem = await session.prepare()
          if (problem) return fail(problem)
          if (!last || closed) return
          const reply = await api.prompt(session.sessionId, agentPromptText(last))
          if (!reply.ok) fail(agentProblem(reply))
        },
      })
    },
    reconnectToStream: async () => null,
  }
}
