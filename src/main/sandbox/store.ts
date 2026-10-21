import { existsSync, readFileSync } from 'node:fs'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { emptyWorkspaceSandbox, type WorkspaceSandbox } from '../../shared/sandbox/sandbox'
import { parseWorkspaceSandbox } from '../../shared/sandbox/sandboxParse'
import { saveJson } from '../platform/jsonStore'

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
      if (!isRecord(raw)) throw new Error('shape')
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
