import { ipcMain, webContents } from 'electron'
import {
  QUESTIONS_PER_PANE,
  QUESTION_RATE_LIMIT,
  QUESTION_RATE_WINDOW_MS,
  type QuestionAskResult,
  type QuestionContent,
  type QuestionEnd,
  type QuestionOutcome,
  type QuestionRequest,
  type QuestionState,
  normalizeQuestion,
  normalizeReply,
} from '../shared/questions'
import { registerControlMethod } from './controlServer'
import { RateWindow } from './rateWindow'

export interface QuestionAsk extends QuestionContent {
  externalId: string
  windowId: string
  paneId: string
}

export interface QuestionDeps {
  publish: (windowId: string, state: QuestionState) => boolean
  now: () => number
}

export type QuestionTicket =
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
        message: `a pane has at most ${QUESTIONS_PER_PANE} open questions`,
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
        resolve(result)
      }
      pending.set(req.id, {
        windowId: request.windowId,
        externalId: request.externalId,
        req,
        settle,
      })
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

  return { ask, answer, dismiss, withdraw, forget, rehome, stateFor }
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

export function registerQuestions(): void {
  const current = createQuestions({ publish: publishToWindow, now: Date.now })
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
