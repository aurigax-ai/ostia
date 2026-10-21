import { ipcMain, webContents } from 'electron'
import type { PermissionInfo } from '../../shared/agents/agentPermissions'
import {
  normalizeQuestion,
  normalizeReply,
  QUESTION_RATE_LIMIT,
  QUESTION_RATE_WINDOW_MS,
  QUESTIONS_PER_PANE,
  type QuestionAskResult,
  type QuestionContent,
  type QuestionEnd,
  type QuestionOutcome,
  type QuestionRequest,
  type QuestionSource,
  type QuestionState,
} from '../../shared/agents/questions'
import { registerControlMethod } from '../control/controlServer'
import { RateWindow } from '../platform/rateWindow'

interface QuestionAsk extends QuestionContent {
  externalId: string
  windowId: string
  paneId: string
  permission?: PermissionInfo
  source?: QuestionSource
}

export interface QuestionEvents {
  opened: (request: QuestionRequest) => void
  settled: (id: string, outcome: QuestionOutcome['outcome']) => void
}

export interface QuestionDeps extends Partial<QuestionEvents> {
  publish: (windowId: string, state: QuestionState) => boolean
  now: () => number
}

interface OpenQuestion {
  windowId: string
  request: QuestionRequest
}

type QuestionTicket =
  | { ok: true; id: string; outcome: Promise<QuestionOutcome> }
  | { ok: false; error: 'too-many-questions' | 'rate-limited'; message: string }

interface Pending {
  windowId: string
  externalId: string
  req: QuestionRequest
  settle: (outcome: QuestionOutcome) => void
}

export interface Questions {
  ask: (ask: QuestionAsk) => QuestionTicket
  answer: (windowId: string, id: string, reply: unknown) => boolean
  dismiss: (windowId: string, id: string) => boolean
  withdraw: (id: string) => void
  forget: (externalId: string) => void
  rehome: (externalIds: readonly string[], windowId: string) => void
  stateFor: (windowId: string) => QuestionState
  open: () => OpenQuestion[]
}

export function createQuestions(deps: QuestionDeps): Questions {
  const pending = new Map<string, Pending>()
  const rates = new Map<string, RateWindow>()
  let counter = 0

  const stateFor = (windowId: string): QuestionState => ({
    pending: [...pending.values()]
      .filter((p) => p.windowId === windowId)
      .map((p) => p.req)
      .sort((a, b) => a.at - b.at),
  })

  const publish = (windowId: string): boolean => deps.publish(windowId, stateFor(windowId))

  const openFor = (externalId: string): number =>
    [...pending.values()].filter((p) => p.externalId === externalId).length

  const ask = (request: QuestionAsk): QuestionTicket => {
    if (openFor(request.externalId) >= QUESTIONS_PER_PANE) {
      return {
        ok: false,
        error: 'too-many-questions',
        message: `${request.source ? 'an extension has, per workspace,' : 'a pane has'} at most ${QUESTIONS_PER_PANE} open questions`,
      }
    }
    const rate = rates.get(request.externalId) ?? new RateWindow(QUESTION_RATE_WINDOW_MS)
    rates.set(request.externalId, rate)
    if (!rate.take(QUESTION_RATE_LIMIT, deps.now())) {
      return {
        ok: false,
        error: 'rate-limited',
        message: `at most ${QUESTION_RATE_LIMIT} questions a minute`,
      }
    }
    counter += 1
    const at = deps.now()
    const req: QuestionRequest = {
      id: `question-${counter}`,
      paneId: request.paneId,
      question: request.question,
      context: request.context,
      choices: [...request.choices],
      mode: request.mode,
      at,
      ...(request.timeoutMs === undefined ? {} : { expiresAt: at + request.timeoutMs }),
      ...(request.permission ? { permission: { ...request.permission } } : {}),
      ...(request.source ? { source: { ...request.source } } : {}),
    }
    const outcome = new Promise<QuestionOutcome>((resolve) => {
      const timer =
        request.timeoutMs === undefined
          ? undefined
          : setTimeout(() => settle({ outcome: 'timeout' }), request.timeoutMs)
      const settle = (result: QuestionOutcome): void => {
        const entry = pending.get(req.id)
        if (!entry) return
        pending.delete(req.id)
        clearTimeout(timer)
        publish(entry.windowId)
        deps.settled?.(req.id, result.outcome)
        resolve(result)
      }
      pending.set(req.id, {
        windowId: request.windowId,
        externalId: request.externalId,
        req,
        settle,
      })
      deps.opened?.(req)
      if (!publish(request.windowId)) settle({ outcome: 'closed' })
    })
    return { ok: true, id: req.id, outcome }
  }

  const owned = (windowId: string, id: string): Pending | undefined => {
    const entry = pending.get(id)
    return entry && entry.windowId === windowId ? entry : undefined
  }

  const answer = (windowId: string, id: string, raw: unknown): boolean => {
    const entry = owned(windowId, id)
    if (!entry) return false
    const reply = normalizeReply(entry.req, raw)
    if (!reply) return false
    entry.settle({
      outcome: 'answered',
      choices: reply.choices.map((index) => entry.req.choices[index] as string),
      text: reply.text,
    })
    return true
  }

  const end = (entry: Pending, outcome: QuestionEnd): void => entry.settle({ outcome })

  const dismiss = (windowId: string, id: string): boolean => {
    const entry = owned(windowId, id)
    if (!entry) return false
    end(entry, 'dismissed')
    return true
  }

  const withdraw = (id: string): void => {
    const entry = pending.get(id)
    if (entry) end(entry, 'closed')
  }

  const forget = (externalId: string): void => {
    rates.delete(externalId)
    for (const entry of [...pending.values()]) {
      if (entry.externalId === externalId) end(entry, 'closed')
    }
  }

  const rehome = (externalIds: readonly string[], windowId: string): void => {
    const moving = new Set(externalIds)
    const touched = new Set<string>()
    for (const entry of pending.values()) {
      if (!moving.has(entry.externalId) || entry.windowId === windowId) continue
      touched.add(entry.windowId)
      entry.windowId = windowId
    }
    if (touched.size === 0) return
    touched.add(windowId)
    for (const id of touched) publish(id)
  }

  const open = (): OpenQuestion[] =>
    [...pending.values()].map((p) => ({ windowId: p.windowId, request: p.req }))

  return { ask, answer, dismiss, withdraw, forget, rehome, stateFor, open }
}

function publishToWindow(windowId: string, state: QuestionState): boolean {
  const contents = webContents.fromId(Number(windowId))
  if (!contents || contents.isDestroyed()) return false
  contents.send('questions:changed', state)
  return true
}

let active: Questions | null = null

export function questions(): Questions | null {
  return active
}

export function registerQuestions(events: QuestionEvents): void {
  const current = createQuestions({ publish: publishToWindow, now: Date.now, ...events })
  active = current
  ipcMain.handle('questions:state', (e) => current.stateFor(String(e.sender.id)))
  ipcMain.handle('questions:answer', (e, id: unknown, reply: unknown) =>
    typeof id === 'string' ? current.answer(String(e.sender.id), id, reply) : false,
  )
  ipcMain.handle('questions:dismiss', (e, id: unknown) =>
    typeof id === 'string' ? current.dismiss(String(e.sender.id), id) : false,
  )
  registerControlMethod('question.ask', {
    cap: 'drive-self',
    handler: async (params, ctx): Promise<QuestionAskResult> => {
      const parsed = normalizeQuestion(params)
      if (!parsed.ok) return parsed
      const ticket = current.ask({
        ...parsed.content,
        externalId: ctx.identity.externalId,
        windowId: ctx.identity.windowId,
        paneId: ctx.identity.paneId,
      })
      if (!ticket.ok) return ticket
      const closed = ctx.conn.onClose(() => current.withdraw(ticket.id))
      const outcome = await ticket.outcome
      closed.dispose()
      return { ok: true, ...outcome }
    },
  })
}

export interface ExtensionQuestionDeps {
  windowOfWorkspace: (workspaceId: string) => string | undefined
  extensionName: (extId: string) => string
}

function extensionAskParams(raw: Record<string, unknown>): Record<string, unknown> {
  const { mode, timeoutS, workspaceId: _w, ...rest } = raw
  return {
    ...rest,
    ...(mode === 'multi' ? { multi: true } : {}),
    ...(mode === 'text' ? { choices: [] } : {}),
    ...(timeoutS === undefined ? {} : { timeoutSeconds: timeoutS }),
  }
}

export function registerExtensionQuestions(deps: ExtensionQuestionDeps): void {
  registerControlMethod('ext.ask', {
    callers: 'extensions',
    cap: 'drive-self',
    handler: async (params, ctx) => {
      const current = active
      if (!current) return { ok: false, error: 'no-window' }
      const raw = (typeof params === 'object' && params !== null ? params : {}) as Record<
        string,
        unknown
      >
      const workspaceId = typeof raw.workspaceId === 'string' ? raw.workspaceId : ''
      const windowId = workspaceId ? deps.windowOfWorkspace(workspaceId) : undefined
      if (!windowId)
        return { ok: false, error: 'unknown-workspace', message: 'no window holds that workspace' }
      const parsed = normalizeQuestion(extensionAskParams(raw))
      if (!parsed.ok) return parsed
      const extId = ctx.identity.extId ?? ctx.identity.externalId
      const ticket = current.ask({
        ...parsed.content,
        externalId: `${ctx.identity.externalId}:${workspaceId}`,
        windowId,
        paneId: '',
        source: { extension: deps.extensionName(extId), workspaceId },
      })
      if (!ticket.ok) return ticket
      const closed = ctx.conn.onClose(() => current.withdraw(ticket.id))
      const disposed = ctx.conn.onDispose(() => current.withdraw(ticket.id))
      const cancelled = ctx.token?.onCancellationRequested(() => current.withdraw(ticket.id))
      const outcome = await ticket.outcome
      closed.dispose()
      disposed.dispose()
      cancelled?.dispose()
      if (outcome.outcome !== 'answered') return { ok: true, outcome: outcome.outcome }
      return {
        ok: true,
        outcome: 'answered',
        reply: { choices: outcome.choices, text: outcome.text },
      }
    },
  })
}
