import { basename } from 'node:path'
import type {
  ExtensionEventPayloads,
  ExtensionEventType,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { type ActivityHost, newRecordId } from './hookEvent'
import type { Journal } from './journal'
import { keepsOnDisk } from './recorder'

export const HOST_EVENTS = [
  'pane.created',
  'pane.closed',
  'pane.attention',
  'pane.lifecycle',
  'cwd.changed',
] as const satisfies readonly ExtensionEventType[]

export const BUS_EVENT = 'bus.message' as const

export interface HostWorkspace {
  workspaceId: string
  kind: string
  workDir: string
  sandboxed?: boolean
}

export interface HostRecorderDeps {
  journal: Journal
  now: () => number
  redact: (texts: string[]) => Promise<string[] | null>
  workspace: (workspaceId: string) => Promise<HostWorkspace | null>
  changed: () => void
}

type Fields = Omit<ActivityHost, 'v' | 't' | 'id' | 'kind' | 'pane'>

interface Plan {
  workspaceId: string
  pane: string
  fields: Fields
}

const OSTIA_ENDPOINT = '@ostia'
const EXTENSION_ENDPOINT = '@extension'
const ELSEWHERE_ENDPOINT = '@elsewhere'

function endpointLabel(
  endpoint: ExtensionEventPayloads['bus.message']['from'],
  workspaceId: string,
): string {
  if (endpoint.workspaceId === workspaceId) return endpoint.id
  if (endpoint.workspaceId || endpoint.id === '') return ELSEWHERE_ENDPOINT
  return endpoint.id === 'ostia' ? OSTIA_ENDPOINT : EXTENSION_ENDPOINT
}

function busPlans(payload: ExtensionEventPayloads['bus.message']): Plan[] {
  const workspaces = new Set(
    [payload.from.workspaceId, payload.to.workspaceId].filter((id): id is string => !!id),
  )
  return [...workspaces].map((workspaceId) => ({
    workspaceId,
    pane: payload.to.workspaceId === workspaceId ? payload.to.id : payload.from.id,
    fields: {
      host: 'bus',
      from: endpointLabel(payload.from, workspaceId),
      to: endpointLabel(payload.to, workspaceId),
      message: payload.kind,
      state: payload.phase,
      ref: payload.id,
    },
  }))
}

function plansOf(type: ExtensionEventType, payload: unknown): Plan[] {
  switch (type) {
    case 'pane.created':
    case 'pane.closed': {
      const p = payload as ExtensionEventPayloads['pane.created']
      return [
        {
          workspaceId: p.workspaceId,
          pane: p.paneId,
          fields: { host: type === 'pane.created' ? 'started' : 'closed' },
        },
      ]
    }
    case 'pane.attention': {
      const p = payload as ExtensionEventPayloads['pane.attention']
      if (p.state === 'cleared') return []
      return [
        { workspaceId: p.workspaceId, pane: p.paneId, fields: { host: 'state', state: p.state } },
      ]
    }
    case 'pane.lifecycle': {
      const p = payload as ExtensionEventPayloads['pane.lifecycle']
      return [{ workspaceId: p.workspaceId, pane: p.paneId, fields: { host: p.state } }]
    }
    case 'cwd.changed': {
      const p = payload as ExtensionEventPayloads['cwd.changed']
      return [
        { workspaceId: p.workspaceId, pane: p.paneId, fields: { host: 'folder', folder: p.cwd } },
      ]
    }
    case 'bus.message':
      return busPlans(payload as ExtensionEventPayloads['bus.message'])
    default:
      return []
  }
}

export function folderWithin(cwd: string, workDir: string): string {
  const root = workDir.endsWith('/') ? workDir : `${workDir}/`
  if (cwd === workDir || `${cwd}/` === root) return '.'
  return workDir !== '' && cwd.startsWith(root) ? cwd.slice(root.length) : `…/${basename(cwd)}`
}

export class HostRecorder {
  private queue: Promise<void> = Promise.resolve()
  private readonly last = new Map<string, string>()

  constructor(private readonly deps: HostRecorderDeps) {}

  accept(type: ExtensionEventType, payload: unknown): void {
    const now = this.deps.now()
    for (const plan of plansOf(type, payload)) {
      this.queue = this.queue.then(() => this.store(plan, now)).catch(() => {})
    }
  }

  settled(): Promise<void> {
    return this.queue
  }

  private repeats(plan: Plan, fields: Fields): boolean {
    if (fields.host === 'bus') return false
    const key = `${plan.workspaceId}|${plan.pane}`
    const print = JSON.stringify(fields)
    const same = this.last.get(key) === print
    if (fields.host === 'closed') this.last.delete(key)
    else this.last.set(key, print)
    return same
  }

  private async store(plan: Plan, t: number): Promise<void> {
    const workspace = await this.deps.workspace(plan.workspaceId).catch(() => null)
    const fields = { ...plan.fields }
    if (fields.folder !== undefined) {
      const shown = folderWithin(fields.folder, workspace?.workDir ?? '')
      const clean = (await this.deps.redact([shown]).catch(() => null))?.[0]
      if (!clean) return
      fields.folder = clean
    }
    if (this.repeats(plan, fields)) return
    const record: ActivityHost = {
      v: 2,
      t,
      id: newRecordId(),
      pane: plan.pane,
      kind: 'host',
      ...fields,
    }
    const persist = workspace ? keepsOnDisk(workspace, workspace.kind) : false
    this.deps.journal.append(plan.workspaceId, record, persist)
    this.deps.changed()
  }
}
