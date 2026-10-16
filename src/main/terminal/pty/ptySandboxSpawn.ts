import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { quoteArgv } from '../../../shared/terminal/shellQuote'
import type { PtyAttachResult } from '../../../shared/types'
import { needsPtyRelay } from '../../platform/ptyRelay'
import { PortBridge, bridgesPorts } from '../../sandbox/ports/portBridge'
import { relayForced, sandboxedShellCommand, wrapForTerminal } from '../../sandbox/ptyWrap'
import { SandboxUnavailableError } from '../../sandbox/sandboxHosts'
import { sandboxFailureBanner } from '../../sandbox/spawnBanner'
import { sandboxSpawnEnv } from '../../sandbox/spawnEnv'
import type { WorkspaceSandboxes } from '../../sandbox/workspaceSandboxes'
import { packageCooldownEnv } from '../../sandboxPackages/packageEnv'
import { SANDBOX_NOT_KEPT } from '../../tmux/keepShellsBanner'
import type { KeptShells } from '../../tmux/keptShells'
import { sandboxCwd } from '../spawnCwd'
import type { SpawnPlan } from './ptySpawnPlan'

interface SandboxSpawnDeps {
  workspaceSandboxes: WorkspaceSandboxes
  keptShells: KeptShells
  injectSecrets: (workspaceId: string) => Promise<{ env: Record<string, string>; notice: string }>
  onSandboxSpawnFailure: () => ((workspaceId: string, errors: string[]) => void) | null
}

export type SandboxSpawn = ReturnType<typeof createSandboxSpawn>

export function createSandboxSpawn({
  workspaceSandboxes,
  keptShells,
  injectSecrets,
  onSandboxSpawnFailure,
}: SandboxSpawnDeps) {
  async function spawnSandboxed(
    paneId: string,
    plan: SpawnPlan,
  ): Promise<SpawnPlan | PtyAttachResult> {
    const { identity, workspaceId, shell, stateFile, markNonceFile, wantsKeep } = plan
    const markFiles = markNonceFile ? [markNonceFile] : []
    let {
      secretNotice,
      resizePipe,
      portBridge,
      tokenFile,
      notKept,
      sandboxStamp,
      file,
      args,
      env,
      cwd,
    } = plan
    try {
      writeFileSync(stateFile, '', { mode: 0o600 })
      const secrets = await injectSecrets(workspaceId)
      secretNotice = secrets.notice
      resizePipe = needsPtyRelay(relayForced(app.isPackaged, process.env))
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
        if (!workspaceSandboxes.hosts.isKept(workspaceId)) notKept = SANDBOX_NOT_KEPT
      }
      if (wantsKeep && !notKept) tokenFile = keptShells.writeToken(paneId, identity.token)
      const wrapped = await workspaceSandboxes.wrap(
        workspaceId,
        sandboxedShellCommand(
          quoteArgv([shell, ...args]),
          env.SHELL,
          resizePipe,
          portBridge?.command ?? null,
        ),
        'bash',
        tokenFile
          ? [stateFile, keptShells.attentionFile(paneId), ...markFiles]
          : [stateFile, ...markFiles],
        tokenFile ? [tokenFile, keptShells.attentionFile(paneId), ...markFiles] : markFiles,
      )
      sandboxStamp = workspaceSandboxes.wrapStamp(workspaceId)
      file = '/bin/sh'
      args = ['-c', wrapForTerminal(wrapped, resizePipe)]
      env = {
        ...sandboxSpawnEnv(env),
        ...packageCooldownEnv(
          workspaceSandboxes.packagePolicy(workspaceId).cooldownDays,
          Date.now(),
        ),
        ...secrets.env,
      }
      env.TMPDIR = workspaceSandboxes.tmp.tmpDir(workspaceId)
      cwd = sandboxCwd(cwd, workspaceSandboxes.workDir(workspaceId))
      return {
        ...plan,
        secretNotice,
        resizePipe,
        portBridge,
        tokenFile,
        notKept,
        sandboxStamp,
        file,
        args,
        env,
        cwd,
      }
    } catch (err) {
      portBridge?.close()
      if (tokenFile) keptShells.removeToken(paneId)
      if (markNonceFile) rmSync(markNonceFile, { force: true })
      const missing = err instanceof SandboxUnavailableError ? err.missing : []
      onSandboxSpawnFailure()?.(workspaceId, missing)
      return {
        created: false,
        buffer: sandboxFailureBanner(err instanceof Error ? err.message : String(err), missing),
        cursor: 0,
        dropped: false,
        sandboxed: true,
      }
    }
  }

  return { spawnSandboxed }
}
