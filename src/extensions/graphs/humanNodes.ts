import {
  NodeError,
  type NodeKind,
  type NodeWait,
  type Notice,
  type Output,
} from '../../../graph-engine/src/engine/contract'
import { type ProcessRunner, commandNode } from '../../../graph-engine/src/kinds/command'
import { DEFAULT_CHOICES } from '../../../graph-engine/src/kinds/humanKinds'
import { notifyNode } from '../../../graph-engine/src/kinds/smallKinds'
import type { OstiaExtension } from '../sdk'

const ANSWER = 'answer'

export interface AskDeps {
  ext: Pick<OstiaExtension, 'ask'>
  deliver: (event: Output) => void
}

function askOf(wait: NodeWait | undefined): Record<string, unknown> | null {
  return wait?.on === 'human' ? wait.ask : null
}

export function approvalNode(deps: AskDeps): NodeKind {
  const open = new Map<string, AbortController>()
  const ask = (question: Record<string, unknown>, scope: string): void => {
    const key = String(question.key)
    open.get(key)?.abort()
    const abort = new AbortController()
    open.set(key, abort)
    void deps.ext
      .ask(
        {
          workspaceId: scope,
          question: String(question.question),
          context: String(question.context),
          choices: question.choices as string[],
        },
        abort.signal,
      )
      .then((res) => {
        if (open.get(key) === abort) open.delete(key)
        if (!res.ok || abort.signal.aborted) return
        if (res.outcome === 'answered') {
          const answer = res.reply.choices[0] ?? res.reply.text
          deps.deliver({ type: ANSWER, key, answer, text: res.reply.text, outcome: 'answered' })
        } else if (res.outcome === 'dismissed') {
          deps.deliver({ type: ANSWER, key, outcome: 'dismissed' })
        }
      })
  }
  return {
    kind: 'approval',
    version: 1,
    start: async (input, ctx) => {
      const context = [
        `Graph ${ctx.run.graph}`,
        typeof input.context === 'string' ? input.context : '',
      ]
        .filter(Boolean)
        .join('\n\n')
      const question = {
        key: ctx.run.attemptKey,
        question: String(input.question),
        context,
        choices: Array.isArray(input.choices) ? input.choices.map(String) : DEFAULT_CHOICES,
      }
      ask(question, ctx.scope)
      return { waiting: { on: 'human', ask: question } }
    },
    rearm: async (wait, _started, ctx) => {
      const question = askOf(wait)
      if (question) ask(question, ctx.scope)
    },
    resume: async (_wait, event) => {
      if (event.outcome === 'dismissed')
        throw new NodeError('Dismissed', 'the human dismissed the question')
      return { done: { answer: String(event.answer ?? ''), values: {}, outcome: 'answered' } }
    },
    cancel: async (wait) => {
      const question = askOf(wait)
      if (question) open.get(String(question.key))?.abort()
    },
  }
}

function execRunner(ext: Pick<OstiaExtension, 'exec'>): ProcessRunner {
  return async (req) => {
    const res = await ext.exec(
      { workspaceId: req.scope, command: req.argv, timeoutMs: req.timeoutMs, env: req.env },
      req.signal,
    )
    if (res.ok) {
      return {
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        timedOut: res.timedOut,
        truncated: res.truncated,
      }
    }
    if (res.error === 'sandbox-unavailable') {
      throw new NodeError(
        'SandboxUnavailable',
        res.message ?? 'the workspace sandbox could not start',
      )
    }
    throw new NodeError('BadOutput', `${res.error}${res.message ? `: ${res.message}` : ''}`)
  }
}

export function ostiaCommandNode(ext: Pick<OstiaExtension, 'exec'>): NodeKind {
  return commandNode(execRunner(ext))
}

export function panelNotifier(ext: Pick<OstiaExtension, 'notifyPanel'>): (notice: Notice) => void {
  return (notice) => {
    void ext.notifyPanel(notice.title, notice.body, notice.run ? `?run=${notice.run}` : undefined)
  }
}

export function ostiaNotifyNode(ext: Pick<OstiaExtension, 'notifyPanel'>): NodeKind {
  return notifyNode(panelNotifier(ext))
}
