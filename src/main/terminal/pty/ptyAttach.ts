import { rmSync } from 'node:fs'
import type { PtyAttachResult, PtySpawnOptions } from '../../../shared/terminal/ptyApi'
import { panesOwnedBy } from '../../control/idRegistry'
import type { Telemetry } from '../../diagnostics/telemetry'
import { sandboxFailureBanner } from '../../sandbox/spawnBanner'
import type { KeptReattach } from '../../tmux/keptReattach'
import type { KeptShells } from '../../tmux/keptShells'
import type { KeptSpawn, KeptSpawner } from '../../tmux/keptSpawn'
import { errorBanner, type PaneBannerText } from '../paneBanner'
import { withPaneToken } from '../terminalType'
import type { LiveAttach } from './ptyLiveAttach'
import type { PtyEntry, PtyRegistry } from './ptyRegistry'
import type { SandboxSpawn } from './ptySandboxSpawn'
import type { SpawnPlan, SpawnPlanner } from './ptySpawnPlan'
import type { PtyStart } from './ptyStart'

interface PtyAttachDeps {
  ptys: Map<string, PtyEntry>
  keptShells: KeptShells
  loadPty: PtyRegistry['loadPty']
  subscriberFor: LiveAttach['subscriberFor']
  attachExisting: LiveAttach['attachExisting']
  reattachKept: KeptReattach['reattachKept']
  planSpawn: SpawnPlanner['planSpawn']
  spawnSandboxed: SandboxSpawn['spawnSandboxed']
  spawnKept: KeptSpawner['spawnKept']
  startTracked: PtyStart['startTracked']
  historySettled: (paneId: string) => Promise<void>
  telemetry: () => Telemetry | null
  bannerText: () => PaneBannerText
}

export type PtyAttach = ReturnType<typeof createPtyAttach>

function dropMarkNonce(plan: SpawnPlan): void {
  if (plan.markNonceFile) rmSync(plan.markNonceFile, { force: true })
}

export function createPtyAttach({
  ptys,
  keptShells,
  loadPty,
  subscriberFor,
  attachExisting,
  reattachKept,
  planSpawn,
  spawnSandboxed,
  spawnKept,
  startTracked,
  historySettled,
  telemetry,
  bannerText,
}: PtyAttachDeps) {
  async function attachPty(
    e: Electron.IpcMainInvokeEvent,
    paneId: string,
    opts: PtySpawnOptions,
  ): Promise<PtyAttachResult> {
    const subId = String(e.sender.id)
    if (!panesOwnedBy([paneId], subId)) {
      return { created: false, buffer: '', cursor: 0, dropped: false }
    }
    const mkSub = subscriberFor(e, paneId, opts, subId)

    const existing = ptys.get(paneId)
    if (existing) return attachExisting(existing, e, paneId, opts, mkSub)
    await historySettled(paneId)
    const settled = ptys.get(paneId)
    if (settled) return attachExisting(settled, e, paneId, opts, mkSub)
    await keptShells.ready
    const keptShell = keptShells.claim(paneId)
    if (keptShell) return reattachKept(e, paneId, opts, keptShell, mkSub)
    if (keptShells.takeSandboxLost(paneId)) {
      return {
        created: false,
        buffer: sandboxFailureBanner(bannerText(), bannerText().sandboxEnded, []),
        cursor: 0,
        dropped: false,
        sandboxed: true,
      }
    }
    if (opts.attachOnly) return { created: false, buffer: '', cursor: 0, dropped: false }

    const mod = loadPty()
    if (!mod) {
      telemetry()?.count('terminal', 'spawn_failure', 'node-pty-unavailable')
      return {
        created: false,
        buffer: errorBanner(bannerText().nodePtyMissing),
        cursor: 0,
        dropped: false,
      }
    }
    const planned = await planSpawn(paneId, opts, subId)
    if ('created' in planned) return planned
    let plan = planned
    if (plan.sandboxed) {
      const wrapped = await spawnSandboxed(paneId, plan)
      if ('created' in wrapped) return wrapped
      plan = wrapped
    }
    if (ptys.has(paneId)) {
      plan.portBridge?.close()
      dropMarkNonce(plan)
      return attachPty(e, paneId, opts)
    }
    const tokenFile =
      plan.wantsKeep && !plan.notKept && !plan.tokenFile
        ? keptShells.writeToken(paneId, plan.identity.token)
        : plan.tokenFile
    plan = { ...plan, tokenFile, env: withPaneToken(plan.env, plan.identity.token, tokenFile) }
    let spawned: KeptSpawn = { kept: null, keptMeta: null }
    if (plan.wantsKeep && !plan.notKept) {
      const { notKept, ...keptSpawn } = await spawnKept(paneId, plan)
      if (ptys.has(paneId)) {
        keptSpawn.kept?.kill()
        dropMarkNonce(plan)
        return attachPty(e, paneId, opts)
      }
      spawned = keptSpawn
      plan = { ...plan, notKept }
    }
    return startTracked(e, paneId, mod, plan, spawned, mkSub)
  }

  return { attachPty }
}
