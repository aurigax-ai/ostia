import type { Capability } from './capabilities'

export const APPROVAL_MODES = ['ask', 'allow'] as const
export type ApprovalMode = (typeof APPROVAL_MODES)[number]

export const APPROVAL_ANSWERS = ['once', 'session', 'always', 'workspace', 'deny'] as const
export type ApprovalAnswer = (typeof APPROVAL_ANSWERS)[number]

export type ApprovalOutcome = ApprovalAnswer | 'auto' | 'timeout'

export const APPROVAL_TIMEOUT_MS = 90_000
export const APPROVAL_HISTORY_MAX = 100
export const APPROVAL_DETAIL_MAX = 600

export const ALWAYS_ASK: readonly Capability[] = ['destructive', 'credentials']

export const APPROVAL_KINDS = [
  'capability',
  'sandbox-domain',
  'sandbox-port',
  'secret',
  'package',
  'package-malware',
] as const
export type ApprovalKind = (typeof APPROVAL_KINDS)[number]

export function answersFor(kind: ApprovalKind = 'capability'): readonly ApprovalAnswer[] {
  if (kind === 'capability') return ['once', 'session', 'always', 'deny']
  if (kind === 'secret') return ['once', 'session', 'deny']
  if (kind === 'package') return ['once', 'workspace', 'deny']
  if (kind === 'package-malware') return ['once', 'deny']
  return ['workspace', 'session', 'deny']
}

const STANDING_ANSWERS: readonly ApprovalAnswer[] = ['session', 'always']

export function offeredAnswers(req: Pick<ApprovalRequest, 'kind' | 'caps'>): ApprovalAnswer[] {
  const alwaysAsks = req.caps.some((cap) => ALWAYS_ASK.includes(cap))
  return answersFor(req.kind).filter((answer) => !(alwaysAsks && STANDING_ANSWERS.includes(answer)))
}

export interface ApprovalRequest {
  id: string
  kind?: ApprovalKind
  subject?: string
  paneId: string
  workspaceId: string
  caps: Capability[]
  action: string
  detail: string
  at: number
}

export interface ApprovalRecord extends ApprovalRequest {
  outcome: ApprovalOutcome
  answeredAt: number
  revocable: boolean
}

export interface ApprovalState {
  pending: ApprovalRequest[]
  history: ApprovalRecord[]
}

export interface ApprovalSettings {
  mode: ApprovalMode
}

export const DEFAULT_APPROVAL_SETTINGS: ApprovalSettings = { mode: 'ask' }

export function parseApprovalSettings(raw: unknown): ApprovalSettings {
  const mode = (raw as { mode?: unknown } | null | undefined)?.mode
  return {
    mode: APPROVAL_MODES.includes(mode as ApprovalMode)
      ? (mode as ApprovalMode)
      : DEFAULT_APPROVAL_SETTINGS.mode,
  }
}

export function autoApproves(
  mode: ApprovalMode,
  caps: readonly Capability[],
  kind: ApprovalKind = 'capability',
): boolean {
  return kind === 'capability' && mode === 'allow' && !caps.some((cap) => ALWAYS_ASK.includes(cap))
}
