import type { AppLog } from '../diagnostics/appLog'
import type { SpawnPlan } from '../terminal/pty/ptySpawnPlan'
import type { KeptPlumbing } from './keptLaunchers'
import type { KeptMeta, KeptProgram, KeptShells } from './keptShells'
import type { TmuxPane } from './tmuxPane'

export interface KeptSpawn {
  kept: TmuxPane | null
  keptMeta: KeptMeta | null
}

interface KeptSpawnerDeps {
  keptShells: KeptShells
  keptPlumbing: KeptPlumbing
  withKeptProcess: (meta: KeptMeta) => KeptMeta
  keptPaneEnv: (env: NodeJS.ProcessEnv) => Record<string, string>
  appLog: () => AppLog | null
}

export async function tmuxMissingReason(
  program: () => KeptProgram | null,
  loginPathSettled: () => Promise<void>,
  missing: string,
): Promise<string> {
  if (program()) return ''
  await loginPathSettled()
  return program() ? '' : missing
}

export type KeptSpawner = ReturnType<typeof createKeptSpawner>

export function createKeptSpawner({
  keptShells,
  keptPlumbing,
  withKeptProcess,
  keptPaneEnv,
  appLog,
}: KeptSpawnerDeps) {
  async function spawnKept(
    paneId: string,
    plan: SpawnPlan,
  ): Promise<KeptSpawn & { notKept: string }> {
    const {
      identity,
      workspaceId,
      shell,
      cols,
      rows,
      stateFile,
      markNonce,
      env,
      sandboxStamp,
      resizePipe,
      portBridge,
      file,
      args,
      cwd,
      sandboxed,
      agentDir,
    } = plan
    let { notKept } = plan
    let kept: TmuxPane | null = null
    keptPlumbing.ensure()
    let keptMeta: KeptMeta | null = withKeptProcess({
      paneId,
      externalId: identity.externalId,
      workspaceId,
      shell,
      stateFile,
      spawnPath: env.PATH ?? '',
      agentDir,
      ...(markNonce ? { markNonce } : {}),
      ...(sandboxed
        ? { sandbox: { stamp: sandboxStamp, bridgeId: portBridge?.id ?? null, resizePipe } }
        : {}),
    })
    try {
      kept = await keptShells.spawn({
        file,
        args,
        cwd,
        env: keptPaneEnv(env),
        cols,
        rows,
        meta: keptMeta,
      })
    } catch (err) {
      notKept = err instanceof Error ? err.message : String(err)
      keptMeta = null
      appLog()?.info('kept-spawn-failed', { pane: paneId, reason: notKept })
    }
    return { kept, keptMeta, notKept }
  }

  return { spawnKept }
}
