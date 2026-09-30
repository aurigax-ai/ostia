import type { ApprovalOutcome } from '../../shared/approvals'
import { type PackageRef, packageVersionKey } from '../../shared/packages'
import type { PackageBlockReason } from './packagePolicy'

export interface BlockedPackage {
  ref: PackageRef
  reason: PackageBlockReason
}

export interface PackageAsk {
  workspaceId: string
  kind: 'package' | 'package-malware'
  malware: boolean
  packages: BlockedPackage[]
}

export interface PackageRequestsDeps {
  ask: (ask: PackageAsk) => Promise<ApprovalOutcome>
  allowWorkspace: (workspaceId: string, versionKey: string) => void
  allowUntilRestart: (workspaceId: string, versionKey: string) => void
  batchMs: number
}

interface Batch {
  items: Map<string, BlockedPackage>
  timer: ReturnType<typeof setTimeout>
}

export class PackageRequests {
  private readonly batches = new Map<string, Batch>()
  private readonly asked = new Map<string, Set<string>>()

  constructor(private readonly deps: PackageRequestsDeps) {}

  blocked(workspaceId: string, ref: PackageRef, reason: PackageBlockReason): void {
    const key = packageVersionKey(ref)
    const asked = this.asked.get(workspaceId) ?? new Set<string>()
    if (asked.has(key)) return
    asked.add(key)
    this.asked.set(workspaceId, asked)
    const batch = this.batches.get(workspaceId) ?? {
      items: new Map<string, BlockedPackage>(),
      timer: setTimeout(() => void this.flush(workspaceId), this.deps.batchMs),
    }
    batch.items.set(key, { ref, reason })
    this.batches.set(workspaceId, batch)
  }

  forget(workspaceId: string): void {
    const batch = this.batches.get(workspaceId)
    if (batch) clearTimeout(batch.timer)
    this.batches.delete(workspaceId)
    this.asked.delete(workspaceId)
  }

  private async flush(workspaceId: string): Promise<void> {
    const batch = this.batches.get(workspaceId)
    if (!batch) return
    this.batches.delete(workspaceId)
    const items = [...batch.items.values()]
    const malicious = items.filter((i) => i.reason === 'malware')
    const others = items.filter((i) => i.reason !== 'malware')
    if (malicious.length > 0) await this.decide(workspaceId, malicious, true)
    if (others.length > 0) await this.decide(workspaceId, others, false)
  }

  private async decide(workspaceId: string, packages: BlockedPackage[], malware: boolean) {
    const outcome = await this.deps.ask({
      workspaceId,
      kind: malware ? 'package-malware' : 'package',
      malware,
      packages,
    })
    const asked = this.asked.get(workspaceId)
    for (const { ref } of packages) {
      const key = packageVersionKey(ref)
      if (outcome === 'workspace' && !malware) this.deps.allowWorkspace(workspaceId, key)
      else if (outcome === 'once' || (outcome === 'session' && !malware)) {
        this.deps.allowUntilRestart(workspaceId, key)
      }
      if (outcome === 'deny' || outcome === 'timeout') asked?.add(key)
    }
  }
}
