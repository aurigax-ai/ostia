import { existsSync, readFileSync } from 'node:fs'
import {
  DEFAULT_SANDBOX_GLOBALS,
  type SandboxControls,
  type SandboxGlobals,
  type WorkspaceSandbox,
  emptyWorkspaceSandbox,
} from '../../shared/sandbox'
import { saveJson } from '../jsonStore'

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : null
}

function parseControls(value: unknown): Partial<SandboxControls> | null {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const out: Partial<SandboxControls> = {}
  if (raw.allWorkspaces !== undefined) {
    if (typeof raw.allWorkspaces !== 'boolean') return null
    out.allWorkspaces = raw.allWorkspaces
  }
  if (raw.browser !== undefined) {
    if (raw.browser !== 'allowlist' && raw.browser !== 'unrestricted') return null
    out.browser = raw.browser
  }
  return out
}

export function parseWorkspaceSandbox(value: unknown): WorkspaceSandbox | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const allowRead = stringList(raw.allowRead ?? [])
  const domains = stringList(raw.domains ?? [])
  const controls = parseControls(raw.controls)
  if (typeof raw.enabled !== 'boolean' || !allowRead || !domains || !controls) return null
  return { enabled: raw.enabled, allowRead, domains, controls }
}

export function parseSandboxGlobals(value: unknown): SandboxGlobals {
  if (typeof value !== 'object' || value === null) return DEFAULT_SANDBOX_GLOBALS
  const raw = value as Record<string, unknown>
  const controls = parseControls(raw.controls) ?? {}
  return {
    allowRead: stringList(raw.allowRead) ?? DEFAULT_SANDBOX_GLOBALS.allowRead,
    allowedDomains: stringList(raw.allowedDomains) ?? DEFAULT_SANDBOX_GLOBALS.allowedDomains,
    controls: { ...DEFAULT_SANDBOX_GLOBALS.controls, ...controls },
  }
}

export class SandboxStore {
  private entries = new Map<string, WorkspaceSandbox>()
  private corrupt = false

  constructor(private readonly path: string) {
    this.load()
  }

  get isCorrupt(): boolean {
    return this.corrupt
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as unknown
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('shape')
      for (const [id, value] of Object.entries(raw)) {
        const parsed = parseWorkspaceSandbox(value)
        if (!parsed) throw new Error(`entry ${id}`)
        this.entries.set(id, parsed)
      }
    } catch {
      this.entries.clear()
      this.corrupt = true
    }
  }

  get(workspaceId: string): WorkspaceSandbox {
    return this.entries.get(workspaceId) ?? emptyWorkspaceSandbox()
  }

  has(workspaceId: string): boolean {
    return this.entries.has(workspaceId)
  }

  set(workspaceId: string, next: WorkspaceSandbox): WorkspaceSandbox {
    this.entries.set(workspaceId, next)
    this.save()
    return next
  }

  remove(workspaceId: string): void {
    if (this.entries.delete(workspaceId)) this.save()
  }

  private save(): void {
    if (this.corrupt) return
    saveJson(this.path, Object.fromEntries(this.entries), { secure: true })
  }
}
