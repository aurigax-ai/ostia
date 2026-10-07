import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain, webContents } from 'electron'
import {
  APPROVAL_ANSWERS,
  APPROVAL_DETAIL_MAX,
  APPROVAL_HISTORY_MAX,
  APPROVAL_TIMEOUT_MS,
  type ApprovalAnswer,
  type ApprovalKind,
  type ApprovalMode,
  type ApprovalOutcome,
  type ApprovalRecord,
  type ApprovalRequest,
  type ApprovalState,
  autoApproves,
  offeredAnswers,
  parseApprovalSettings,
} from '../shared/approvals'
import { ALL_CAPABILITIES, type Capability } from '../shared/capabilities'
import { clip } from '../shared/pick'
import {
  addStandingGrants,
  grant,
  removeStandingGrant,
  revoke,
  setReachMode,
} from './capabilityStore'

export interface ApprovalAsk {
  externalId: string
  windowId: string
  paneId: string
  workspaceId: string
  caps: Capability[]
  action: string
  detail: string
  kind?: ApprovalKind
  subject?: string
}

export interface ApprovalEvents {
  opened: (request: ApprovalRequest) => void
  settled: (id: string, outcome: ApprovalOutcome) => void
}

export interface OpenApproval {
  windowId: string
  request: ApprovalRequest
}

export interface ApprovalDeps extends Partial<ApprovalEvents> {
  mode: () => ApprovalMode
  publish: (windowId: string, state: ApprovalState) => boolean
  grant: (externalId: string, cap: Capability) => void
  revoke: (externalId: string, cap: Capability) => void
  always: (caps: readonly Capability[]) => boolean
  now: () => number
  timeoutMs: number
  reveal: (windowId: string) => void
}

interface Owned {
  windowId: string
  externalId: string
}

interface Pending extends Owned {
  req: ApprovalRequest
  settle: (outcome: ApprovalOutcome) => void
}

type StoredRecord = ApprovalRecord & Owned

export interface Approvals {
  request: (ask: ApprovalAsk) => Promise<ApprovalOutcome>
  answer: (windowId: string, id: string, answer: unknown) => boolean
  revoke: (windowId: string, id: string) => boolean
  stateFor: (windowId: string) => ApprovalState
  forget: (externalId: string) => void
  rehome: (externalIds: readonly string[], windowId: string) => void
  open: () => OpenApproval[]
}

function publicRecord({ windowId: _w, externalId: _e, ...record }: StoredRecord): ApprovalRecord {
  return record
}

export function createApprovals(deps: ApprovalDeps): Approvals {
  const pending = new Map<string, Pending>()
  const history: StoredRecord[] = []
  let counter = 0

  const stateFor = (windowId: string): ApprovalState => ({
    pending: [...pending.values()].filter((p) => p.windowId === windowId).map((p) => p.req),
    history: history.filter((r) => r.windowId === windowId).map(publicRecord),
  })

  const publish = (windowId: string): boolean => deps.publish(windowId, stateFor(windowId))

  const record = (owned: Owned, req: ApprovalRequest, outcome: ApprovalOutcome): void => {
    history.unshift({
      ...req,
      ...owned,
      outcome,
      answeredAt: deps.now(),
      revocable: outcome === 'session' && (req.kind ?? 'capability') === 'capability',
    })
    history.length = Math.min(history.length, APPROVAL_HISTORY_MAX)
  }

  const request = (ask: ApprovalAsk): Promise<ApprovalOutcome> => {
    counter += 1
    const req: ApprovalRequest = {
      id: `approval-${counter}`,
      kind: ask.kind ?? 'capability',
      ...(ask.subject === undefined ? {} : { subject: ask.subject }),
      paneId: ask.paneId,
      workspaceId: ask.workspaceId,
      caps: [...ask.caps],
      action: ask.action,
      detail: clip(ask.detail, APPROVAL_DETAIL_MAX),
      at: deps.now(),
    }
    const owned: Owned = { windowId: ask.windowId, externalId: ask.externalId }
    if (autoApproves(deps.mode(), req.caps, req.kind)) {
      record(owned, req, 'auto')
      publish(ask.windowId)
      return Promise.resolve('auto')
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle('timeout'), deps.timeoutMs)
      const settle = (outcome: ApprovalOutcome): void => {
        if (!pending.delete(req.id)) return
        clearTimeout(timer)
        const standing = outcome === 'session' || outcome === 'always'
        if (standing && (req.kind ?? 'capability') === 'capability') {
          for (const cap of req.caps) deps.grant(ask.externalId, cap)
        }
        record(owned, req, outcome)
        publish(ask.windowId)
        deps.settled?.(req.id, outcome)
        resolve(outcome)
      }
      pending.set(req.id, { ...owned, req, settle })
      deps.opened?.(req)
      if (!publish(ask.windowId)) settle('deny')
      else deps.reveal(ask.windowId)
    })
  }

  const answer = (windowId: string, id: string, value: unknown): boolean => {
    const entry = pending.get(id)
    if (!entry || entry.windowId !== windowId) return false
    if (!APPROVAL_ANSWERS.includes(value as ApprovalAnswer)) return false
    if (!offeredAnswers(entry.req).includes(value as ApprovalAnswer)) return false
    if (value === 'always' && !deps.always(entry.req.caps)) return false
    entry.settle(value as ApprovalAnswer)
    return true
  }

  const revokeRecord = (windowId: string, id: string): boolean => {
    const entry = history.find((r) => r.id === id)
    if (!entry || entry.windowId !== windowId || !entry.revocable) return false
    for (const cap of entry.caps) deps.revoke(entry.externalId, cap)
    entry.revocable = false
    publish(windowId)
    return true
  }

  const forget = (externalId: string): void => {
    for (const entry of pending.values()) {
      if (entry.externalId === externalId) entry.settle('deny')
    }
    const touched = new Set<string>()
    for (const entry of history) {
      if (entry.externalId === externalId && entry.revocable) {
        entry.revocable = false
        touched.add(entry.windowId)
      }
    }
    for (const windowId of touched) publish(windowId)
  }

  const rehome = (externalIds: readonly string[], windowId: string): void => {
    const moving = new Set(externalIds)
    const touched = new Set<string>()
    for (const entry of [...pending.values(), ...history]) {
      if (!moving.has(entry.externalId) || entry.windowId === windowId) continue
      touched.add(entry.windowId)
      entry.windowId = windowId
    }
    if (touched.size === 0) return
    touched.add(windowId)
    for (const id of touched) publish(id)
  }

  const open = (): OpenApproval[] =>
    [...pending.values()].map((p) => ({ windowId: p.windowId, request: p.req }))

  return { request, answer, revoke: revokeRecord, stateFor, forget, rehome, open }
}

function readApprovalMode(): ApprovalMode {
  try {
    const path = join(app.getPath('userData'), 'settings.json')
    if (!existsSync(path)) return parseApprovalSettings(undefined).mode
    const settings = JSON.parse(readFileSync(path, 'utf8')) as { approvals?: unknown }
    return parseApprovalSettings(settings.approvals).mode
  } catch {
    return parseApprovalSettings(undefined).mode
  }
}

function publishToWindow(windowId: string, state: ApprovalState): boolean {
  const contents = webContents.fromId(Number(windowId))
  if (!contents || contents.isDestroyed()) return false
  contents.send('approvals:changed', state)
  return true
}

let active: Approvals | null = null

export function approvals(): Approvals | null {
  return active
}

export function registerApprovals(
  reveal: (windowId: string) => void,
  settingsChanged: () => void,
  events: ApprovalEvents,
): void {
  const persist = (write: () => boolean): boolean => {
    if (!write()) return false
    settingsChanged()
    return true
  }
  active = createApprovals({
    mode: readApprovalMode,
    publish: publishToWindow,
    grant,
    revoke,
    always: (caps) => persist(() => addStandingGrants(caps)),
    now: Date.now,
    timeoutMs: APPROVAL_TIMEOUT_MS,
    reveal,
    ...events,
  })
  const current = active
  ipcMain.handle('approvals:state', (e) => current.stateFor(String(e.sender.id)))
  ipcMain.handle('approvals:answer', (e, id: unknown, answer: unknown) =>
    typeof id === 'string' ? current.answer(String(e.sender.id), id, answer) : false,
  )
  ipcMain.handle('approvals:revoke', (e, id: unknown) =>
    typeof id === 'string' ? current.revoke(String(e.sender.id), id) : false,
  )
  ipcMain.handle('approvals:remove-always', (_e, cap: unknown) =>
    ALL_CAPABILITIES.includes(cap as Capability)
      ? persist(() => removeStandingGrant(cap as Capability))
      : false,
  )
  ipcMain.handle('approvals:set-reach', (e, mode: unknown) =>
    e.sender.getType() === 'window' ? persist(() => setReachMode(mode)) : false,
  )
}
