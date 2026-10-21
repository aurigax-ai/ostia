const PANE_STATES = [
  'working',
  'waiting',
  'done',
  'error',
  'idle',
  'hibernated',
  'waking',
  'exited',
  'shell',
] as const

export const SHORT_ID_LENGTH = 8

export function shortId(id: string): string {
  return id.slice(0, SHORT_ID_LENGTH)
}

export type PaneStateName = (typeof PANE_STATES)[number]

export interface PaneStatusChanges {
  first: boolean
  states: string[]
  commands: number
  failed: number
  closing: boolean
  mail: number
}

export interface PaneStatus {
  pane: string
  title: string
  state: PaneStateName
  sinceMs?: number
  closing?: string
  exitCode?: number
  process?: { id: string; status: string }
  git?: { branch: string | null; ahead: number; behind: number; changed: number }
  mail: { queued: number; failed: number; sentQueued: number; sentFailed: number }
  stale: string[]
  conflict: string[]
  changes: PaneStatusChanges
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function ageLabel(ms: number): string {
  if (ms < MINUTE) return `${Math.max(0, Math.floor(ms / 1000))}s`
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`
  return `${Math.floor(ms / DAY)}d`
}

function gitPart(git: NonNullable<PaneStatus['git']>): string {
  return [
    git.branch ?? 'detached',
    git.changed > 0 ? `+${git.changed}` : '',
    git.ahead > 0 ? `↑${git.ahead}` : '',
    git.behind > 0 ? `↓${git.behind}` : '',
  ]
    .filter(Boolean)
    .join(' ')
}

function changesPart(changes: PaneStatusChanges): string {
  if (changes.first) return 'first look'
  const parts = [
    changes.states.length > 1 ? changes.states.join('→') : '',
    changes.commands > 0 ? `${changes.commands} commands, ${changes.failed} failed` : '',
    changes.closing ? 'new closing line' : '',
    changes.mail > 0 ? `${changes.mail} mail delivered` : '',
  ].filter(Boolean)
  return parts.length > 0 ? `since last: ${parts.join(', ')}` : 'no change since last'
}

export function statusLine(status: PaneStatus): string {
  const stateText =
    status.sinceMs === undefined ? status.state : `${status.state} ${ageLabel(status.sinceMs)}`
  const mailText = [
    `mail ${status.mail.queued}`,
    status.mail.failed > 0 ? `failed ${status.mail.failed}` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const parts = [
    shortId(status.pane),
    status.title,
    stateText,
    status.exitCode === undefined ? '' : `exit ${status.exitCode}`,
    status.process ? `process ${status.process.id} ${status.process.status}` : '',
    status.git ? gitPart(status.git) : '',
    mailText,
    status.closing ? JSON.stringify(status.closing) : '',
    status.stale.length > 0 ? `stale: ${status.stale.join(', ')}` : '',
    status.conflict.length > 0 ? `conflict: ${status.conflict.join(', ')}` : '',
  ].filter(Boolean)
  return `${parts.join('  ')}  (${changesPart(status.changes)})`
}
