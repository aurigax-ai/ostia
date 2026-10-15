import type { PermissionAgent } from '../../shared/agents/agentPermissions'
import type { QuestionRequest } from '../../shared/agents/questions'
import type { Dict } from '../../shared/app/dict'
import {
  ALWAYS_ASK,
  type ApprovalAnswer,
  type ApprovalRequest,
  offeredAnswers,
} from '../../shared/permissions/approvals'
import type { PaneIdentity } from '../control/idRegistry'
import type { Approvals } from './approvals'
import type { Questions } from './questions'

type AskKind = 'permission' | 'question' | 'approval'

type AskTone = 'primary' | 'neutral' | 'danger'

interface AskChoice {
  id: string
  label: string
  tone: AskTone
}

export interface Ask {
  askId: string
  sessionId: string
  paneId: string
  kind: AskKind
  agent?: PermissionAgent
  title: string
  detail?: string
  choices: AskChoice[]
  allowText: boolean
  since: number
}

export interface AskResolved {
  askId: string
  outcome: string
}

export type AskAnswerResult = 'ok' | 'unknown-ask' | 'invalid-answer'

type ApprovalText = Dict['approvals']

export interface AskHubDeps {
  text: () => ApprovalText
  questions: () => Questions | null
  approvals: () => Approvals | null
  identity: (paneId: string) => PaneIdentity | undefined
  created: (ask: Ask) => void
  resolved: (resolved: AskResolved) => void
}

export interface AskHub {
  list: () => Ask[]
  answer: (askId: string, choiceId: unknown, text: unknown) => AskAnswerResult
  questionOpened: (request: QuestionRequest) => void
  approvalOpened: (request: ApprovalRequest) => void
  settled: (askId: string, outcome: string) => void
}

const PERMISSION_ANSWERS: readonly ApprovalAnswer[] = ['once', 'always', 'deny']

const ANSWER_TONES: Record<ApprovalAnswer, AskTone> = {
  once: 'primary',
  session: 'neutral',
  always: 'neutral',
  workspace: 'neutral',
  deny: 'danger',
}

function answerLabel(answer: ApprovalAnswer, text: ApprovalText): string {
  const labels: Record<ApprovalAnswer, string> = {
    once: text.allowOnce,
    session: text.allowSession,
    always: text.allowAlways,
    workspace: text.allowWorkspace,
    deny: text.deny,
  }
  return labels[answer]
}

function answerChoice(answer: ApprovalAnswer, text: ApprovalText): AskChoice {
  return { id: answer, label: answerLabel(answer, text), tone: ANSWER_TONES[answer] }
}

const isPermissionAnswer = (id: string): id is ApprovalAnswer =>
  (PERMISSION_ANSWERS as readonly string[]).includes(id)

function isPhoneApproval(request: ApprovalRequest): boolean {
  return (
    (request.kind ?? 'capability') === 'capability' &&
    !request.caps.some((cap) => ALWAYS_ASK.includes(cap))
  )
}

function questionAsk(
  request: QuestionRequest,
  at: { workspaceId: string; externalId: string },
  text: ApprovalText,
): Ask {
  const base = {
    askId: request.id,
    sessionId: at.workspaceId,
    paneId: at.externalId,
    title: request.question,
    ...(request.context ? { detail: request.context } : {}),
    since: request.at,
  }
  if (request.permission) {
    return {
      ...base,
      kind: 'permission',
      agent: request.permission.agent,
      choices: request.choices.filter(isPermissionAnswer).map((id) => answerChoice(id, text)),
      allowText: false,
    }
  }
  return {
    ...base,
    kind: 'question',
    choices: request.choices.map((label, index) => ({
      id: String(index),
      label,
      tone: 'neutral',
    })),
    allowText: true,
  }
}

function approvalAsk(request: ApprovalRequest, identity: PaneIdentity, text: ApprovalText): Ask {
  return {
    askId: request.id,
    sessionId: identity.workspaceId,
    paneId: identity.externalId,
    kind: 'approval',
    title: request.action,
    ...(request.detail ? { detail: request.detail } : {}),
    choices: offeredAnswers(request).map((answer) => answerChoice(answer, text)),
    allowText: false,
    since: request.at,
  }
}

function choiceIndex(choices: readonly string[], choiceId: unknown, byLabel: boolean): number {
  if (typeof choiceId !== 'string') return -1
  if (byLabel) return choices.indexOf(choiceId)
  const index = Number(choiceId)
  return /^\d+$/.test(choiceId) && index < choices.length ? index : -1
}

export function createAskHub(deps: AskHubDeps): AskHub {
  const shown = new Set<string>()

  const fromQuestion = (request: QuestionRequest): Ask | null => {
    if (request.source)
      return questionAsk(
        request,
        { workspaceId: request.source.workspaceId, externalId: '' },
        deps.text(),
      )
    const identity = deps.identity(request.paneId)
    return identity ? questionAsk(request, identity, deps.text()) : null
  }

  const fromApproval = (request: ApprovalRequest): Ask | null => {
    if (!isPhoneApproval(request)) return null
    const identity = deps.identity(request.paneId)
    return identity ? approvalAsk(request, identity, deps.text()) : null
  }

  const list = (): Ask[] => {
    const questions = (deps.questions()?.open() ?? []).map((q) => fromQuestion(q.request))
    const approvals = (deps.approvals()?.open() ?? []).map((a) => fromApproval(a.request))
    return [...questions, ...approvals]
      .filter((ask): ask is Ask => ask !== null)
      .sort((a, b) => a.since - b.since)
  }

  const answerQuestion = (choiceId: unknown, text: unknown, askId: string): AskAnswerResult => {
    const open = deps
      .questions()
      ?.open()
      .find((q) => q.request.id === askId)
    if (!open) return 'unknown-ask'
    const { request, windowId } = open
    const permission = request.permission !== undefined
    const picked = choiceId === undefined ? -1 : choiceIndex(request.choices, choiceId, permission)
    if (choiceId !== undefined && picked < 0) return 'invalid-answer'
    if (text !== undefined && typeof text !== 'string') return 'invalid-answer'
    const reply = { choices: picked < 0 ? [] : [picked], text: permission ? '' : (text ?? '') }
    return deps.questions()?.answer(windowId, askId, reply) ? 'ok' : 'invalid-answer'
  }

  const answerApproval = (choiceId: unknown, askId: string): AskAnswerResult => {
    const open = deps
      .approvals()
      ?.open()
      .find((a) => a.request.id === askId)
    if (!open || !isPhoneApproval(open.request)) return 'unknown-ask'
    return deps.approvals()?.answer(open.windowId, askId, choiceId) ? 'ok' : 'invalid-answer'
  }

  const answer = (askId: string, choiceId: unknown, text: unknown): AskAnswerResult => {
    if (
      deps
        .questions()
        ?.open()
        .some((q) => q.request.id === askId)
    ) {
      return answerQuestion(choiceId, text, askId)
    }
    return answerApproval(choiceId, askId)
  }

  const announce = (ask: Ask | null): void => {
    if (!ask) return
    shown.add(ask.askId)
    deps.created(ask)
  }

  const settled = (askId: string, outcome: string): void => {
    if (!shown.delete(askId)) return
    deps.resolved({ askId, outcome })
  }

  return {
    list,
    answer,
    questionOpened: (request) => announce(fromQuestion(request)),
    approvalOpened: (request) => announce(fromApproval(request)),
    settled,
  }
}
