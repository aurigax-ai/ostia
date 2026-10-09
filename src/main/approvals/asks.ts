import type { PermissionAgent } from '../../shared/agents/agentPermissions'
import type { QuestionRequest } from '../../shared/agents/questions'
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

export interface AskHubDeps {
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

const PERMISSION_LABELS: Record<string, AskChoice> = {
  once: { id: 'once', label: 'Allow once', tone: 'primary' },
  always: { id: 'always', label: 'Always allow', tone: 'neutral' },
  deny: { id: 'deny', label: 'Deny', tone: 'danger' },
}

const APPROVAL_LABELS: Record<ApprovalAnswer, AskChoice> = {
  once: { id: 'once', label: 'Allow once', tone: 'primary' },
  session: { id: 'session', label: 'Allow for this pane', tone: 'neutral' },
  always: { id: 'always', label: 'Always allow', tone: 'neutral' },
  workspace: { id: 'workspace', label: 'Allow for this workspace', tone: 'neutral' },
  deny: { id: 'deny', label: 'Deny', tone: 'danger' },
}

function isPhoneApproval(request: ApprovalRequest): boolean {
  return (
    (request.kind ?? 'capability') === 'capability' &&
    !request.caps.some((cap) => ALWAYS_ASK.includes(cap))
  )
}

function questionAsk(request: QuestionRequest, identity: PaneIdentity): Ask {
  const base = {
    askId: request.id,
    sessionId: identity.workspaceId,
    paneId: identity.externalId,
    title: request.question,
    ...(request.context ? { detail: request.context } : {}),
    since: request.at,
  }
  if (request.permission) {
    return {
      ...base,
      kind: 'permission',
      agent: request.permission.agent,
      choices: request.choices.flatMap((id) => {
        const choice = PERMISSION_LABELS[id]
        return choice ? [choice] : []
      }),
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

function approvalAsk(request: ApprovalRequest, identity: PaneIdentity): Ask {
  return {
    askId: request.id,
    sessionId: identity.workspaceId,
    paneId: identity.externalId,
    kind: 'approval',
    title: request.action,
    ...(request.detail ? { detail: request.detail } : {}),
    choices: offeredAnswers(request).map((answer) => APPROVAL_LABELS[answer]),
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
    const identity = deps.identity(request.paneId)
    return identity ? questionAsk(request, identity) : null
  }

  const fromApproval = (request: ApprovalRequest): Ask | null => {
    if (!isPhoneApproval(request)) return null
    const identity = deps.identity(request.paneId)
    return identity ? approvalAsk(request, identity) : null
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
