import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { PtyAttachResult } from '../../../shared/terminal/ptyApi'
import { quoteArgv } from '../../../shared/terminal/shellQuote'
import { needsPtyRelay } from '../../platform/ptyRelay'
import { SandboxUnavailableError } from '../../sandbox/hostClient'
import { bridgesPorts, PortBridge } from '../../sandbox/ports/portBridge'
import { relayForced, sandboxedShellCommand, wrapForTerminal } from '../../sandbox/ptyWrap'
import { sandboxFailureBanner } from '../../sandbox/spawnBanner'
import { sandboxSpawnEnv } from '../../sandbox/spawnEnv'
import type { WorkspaceSandboxes } from '../../sandbox/workspaceSandboxes'
import { packageCooldownEnv } from '../../sandboxPackages/packageEnv'
import type { KeptShells } from '../../tmux/keptShells'
import type { PaneBannerText } from '../paneBanner'
import { sandboxCwd } from '../spawnCwd'
import type { SpawnPlan } from './ptySpawnPlan'

interface SandboxSpawnDeps {
  workspaceSandboxes: WorkspaceSandboxes
  keptShells: KeptShells
  injectSecrets: (workspaceId: string) => Promise<{ env: Record<string, string>; notice: string }>
  onSandboxSpawnFailure: () => ((workspaceId: string, errors: string[]) => void) | null
  bannerText: () => PaneBannerText
}

export type SandboxSpawn = ReturnType<typeof createSandboxSpawn>

export function createSandboxSpawn({
  workspaceSandboxes,
  keptShells,
  injectSecrets,
  onSandboxSpawnFailure,
  bannerText,
}: SandboxSpawnDeps) {
  async function spawnSandboxed(
    paneId: string,
    plan: SpawnPlan,
  ): Promise<SpawnPlan | PtyAttachResult> {
    const { identity, workspaceId, shell, stateFile, markNonceFile, wantsKeep } = plan
    const markFiles = markNonceFile ? [markNonceFile] : []
    let { portBridge, tokenFile, notKept } = plan
    try {
      writeFileSync(stateFile, '', { mode: 0o600 })
      const secrets = await injectSecrets(workspaceId)
      const resizePipe = needsPtyRelay(relayForced(app.isPackaged, process.env))
        ? join(workspaceSandboxes.tmp.tmpDir(workspaceId), `resize-${randomUUID()}`)
        : null
      portBridge = bridgesPorts(
        process.platform,
        workspaceSandboxes.resolved(workspaceId).switches.unixSockets,
      )
        ? await PortBridge.open(workspaceSandboxes.tmp.tmpDir(workspaceId))
        : null
      if (wantsKeep && !notKept) {
        await workspaceSandboxes.hosts.connect(workspaceId)
        if (!workspaceSandboxes.hosts.isKept(workspaceId)) notKept = bannerText().sandboxNotKept
      }
      if (wantsKeep && !notKept) tokenFile = keptShells.writeToken(paneId, identity.token)
      const wrapped = await workspaceSandboxes.wrap(
        workspaceId,
        sandboxedShellCommand(
          quoteArgv([shell, ...plan.args]),
          plan.env.SHELL,
          resizePipe,
          portBridge?.command ?? null,
        ),
        'bash',
        tokenFile
          ? [stateFile, keptShells.attentionFile(paneId), ...markFiles]
          : [stateFile, ...markFiles],
        tokenFile ? [tokenFile, keptShells.attentionFile(paneId), ...markFiles] : markFiles,
      )
      const env = {
        ...sandboxSpawnEnv(plan.env),
        ...packageCooldownEnv(
          workspaceSandboxes.packagePolicy(workspaceId).cooldownDays,
          Date.now(),
        ),
        ...secrets.env,
        TMPDIR: workspaceSandboxes.tmp.tmpDir(workspaceId),
      }
      return {
        ...plan,
        secretNotice: secrets.notice,
        resizePipe,
        portBridge,
        tokenFile,
        notKept,
        sandboxStamp: workspaceSandboxes.wrapStamp(workspaceId),
        file: '/bin/sh',
        args: ['-c', wrapForTerminal(wrapped, resizePipe)],
        env,
        cwd: sandboxCwd(plan.cwd, workspaceSandboxes.workDir(workspaceId)),
      }
    } catch (err) {
      portBridge?.close()
      if (tokenFile) keptShells.removeToken(paneId)
      if (markNonceFile) rmSync(markNonceFile, { force: true })
      const missing = err instanceof SandboxUnavailableError ? err.missing : []
      onSandboxSpawnFailure()?.(workspaceId, missing)
      return {
        created: false,
        buffer: sandboxFailureBanner(
          bannerText(),
          err instanceof Error ? err.message : String(err),
          missing,
        ),
        cursor: 0,
        dropped: false,
        sandboxed: true,
      }
    }
  }

  return { spawnSandboxed }
}
