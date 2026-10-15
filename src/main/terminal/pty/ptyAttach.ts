import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import type { PtyAttachResult, PtySpawnOptions } from '../../../shared/types'
import { panesOwnedBy } from '../../control/idRegistry'
import type { Telemetry } from '../../diagnostics/telemetry'
import { sandboxFailureBanner } from '../../sandbox/spawnBanner'
import type { KeptReattach } from '../../tmux/keptReattach'
import type { KeptShells } from '../../tmux/keptShells'
import type { KeptSpawn, KeptSpawner } from '../../tmux/keptSpawn'
import { withPaneToken } from '../terminalType'
import type { LiveAttach } from './ptyLiveAttach'
import type { PtyEntry, PtyRegistry } from './ptyRegistry'
import type { SandboxSpawn } from './ptySandboxSpawn'
import type { SpawnPlanner } from './ptySpawnPlan'
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
  telemetry: () => Telemetry | null
}

export type PtyAttach = ReturnType<typeof createPtyAttach>

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
  telemetry,
}: PtyAttachDeps) {
  const SANDBOX_LOST_WHILE_AWAY = `its sandbox ended while ${PRODUCT_DISPLAY_NAME} was closed`

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
    await keptShells.ready
    const keptShell = keptShells.claim(paneId)
    if (keptShell) return reattachKept(e, paneId, opts, keptShell, mkSub)
    if (keptShells.takeSandboxLost(paneId)) {
      return {
        created: false,
        buffer: sandboxFailureBanner(SANDBOX_LOST_WHILE_AWAY, []),
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
        buffer: '\r\n\x1b[38;2;239;89;111m node-pty unavailable — run: pnpm rebuild\x1b[0m\r\n',
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
        return attachPty(e, paneId, opts)
      }
      spawned = keptSpawn
      plan = { ...plan, notKept }
    }
    return startTracked(e, paneId, mod, plan, spawned, mkSub)
  }

  return { attachPty }
}
