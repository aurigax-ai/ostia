import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { appEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { app } from 'electron'
import { shellArgv } from '../../../shared/terminal/terminalShell'
import type { PtyAttachResult, PtySpawnOptions } from '../../../shared/types'
import type { ArtifactFolders } from '../../artifacts/artifactFolders'
import { controlSocketPath } from '../../control/controlServer'
import { getByPaneId, registerPane } from '../../control/idRegistry'
import type { PaneIdentity } from '../../control/idRegistry'
import type { Telemetry } from '../../diagnostics/telemetry'
import { privateTmpDir } from '../../platform/privateTmp'
import { loginPathSettled } from '../../platform/toolPath'
import { attachWorkspace } from '../../sandbox/attachWorkspace'
import type { HostPaneGrants } from '../../sandbox/hostPanes'
import type { PortBridge } from '../../sandbox/portBridge'
import { sandboxFailureBanner } from '../../sandbox/spawnBanner'
import type { WorkspaceSandboxes } from '../../sandbox/workspaceSandboxes'
import type { KeptProgram } from '../../tmux/keptShells'
import { tmuxMissingReason } from '../../tmux/keptSpawn'
import type { ScratchFolders } from '../../workspaces/scratchFolders'
import { markNonceFileFor, writeMarkNonce } from '../markNonce'
import { sendsMarkNonce, shellIntegrationSpawnOptions } from '../shellIntegration'
import { spawnFolder } from '../spawnCwd'
import type { SpawnFolder } from '../spawnCwd'
import { paneShellEnv } from '../terminalType'

export interface SpawnPlan {
  identity: PaneIdentity
  workspaceId: string
  shell: string
  cols: number
  rows: number
  stateFile: string
  markNonce: string | null
  markNonceFile: string | null
  env: Record<string, string>
  secretNotice: string
  sandboxStamp: string | null
  resizePipe: string | null
  portBridge: PortBridge | null
  file: string
  args: string[]
  folder: SpawnFolder
  cwd: string
  host: boolean
  sandboxed: boolean
  wantsKeep: boolean
  notKept: string
  tokenFile: string | null
}

function shellFamily(shell: string): string {
  const name = basename(shell).toLowerCase()
  return name === 'zsh' || name === 'bash' || name === 'fish' ? name : 'other'
}

interface SpawnPlannerDeps {
  scratchFolders: ScratchFolders
  artifactFolders: ArtifactFolders
  hostPaneGrants: HostPaneGrants
  workspaceSandboxes: WorkspaceSandboxes
  readSettingsFile: () => { terminal?: { shell?: unknown }; agents?: { hooks?: unknown } }
  paneLauncherDir: () => string
  keepShellsOn: () => boolean
  keptShellsProgram: () => KeptProgram | null
  telemetry: () => Telemetry | null
}

export type SpawnPlanner = ReturnType<typeof createSpawnPlanner>

export function createSpawnPlanner({
  scratchFolders,
  artifactFolders,
  hostPaneGrants,
  workspaceSandboxes,
  readSettingsFile,
  paneLauncherDir,
  keepShellsOn,
  keptShellsProgram,
  telemetry,
}: SpawnPlannerDeps) {
  async function planSpawn(
    paneId: string,
    opts: PtySpawnOptions,
    subId: string,
  ): Promise<SpawnPlan | PtyAttachResult> {
    const settings = readSettingsFile()
    const [shell, ...shellArgs] = shellArgv(
      settings.terminal?.shell,
      process.env.SHELL ?? (process.platform === 'win32' ? 'powershell.exe' : 'bash'),
    )
    telemetry()?.count('terminal', 'shell', shellFamily(shell))
    const resolved = attachWorkspace(getByPaneId(paneId)?.workspaceId, opts.workspaceId ?? '')
    if (!resolved.ok) {
      return {
        created: false,
        buffer: sandboxFailureBanner('the pane belongs to another workspace', []),
        cursor: 0,
        dropped: false,
      }
    }
    const identity = registerPane({ windowId: subId, workspaceId: resolved.workspaceId, paneId })
    const workspaceId = identity.workspaceId
    const stateFile = join(privateTmpDir(`${PRODUCT_NAME}-shell-state`), randomUUID())
    const markNonceFile = sendsMarkNonce(shell) ? markNonceFileFor(stateFile) : null
    const markNonce = markNonceFile ? writeMarkNonce(markNonceFile) : null
    const integration = shellIntegrationSpawnOptions(
      shell,
      process.env,
      opts.ostiaPrompt ?? null,
      scratchFolders.historyFile(workspaceId),
      markNonceFile,
    )
    const cols = opts.cols || 80
    const rows = opts.rows || 24
    const env = paneShellEnv({
      version: app.getVersion(),
      locale: app.getLocale(),
      parent: process.env,
      integration: integration.env,
      pane: appEnv({
        PANE_ID: identity.externalId,
        START_DIR: opts.cwd ?? '',
        SOCKET: controlSocketPath(),
        CLI: join(app.getAppPath(), 'out/cli/index.js'),
        NODE: process.execPath,
        SHELL_STATE: stateFile,
      }),
      agentHooks: settings.agents?.hooks,
      artifactsDir: workspaceId ? artifactFolders.ensure(workspaceId) : null,
      launcherDir: paneLauncherDir(),
    })
    const folder = spawnFolder(opts.cwd)
    const host = opts.hostToken ? hostPaneGrants.consume(opts.hostToken) : false
    const sandboxed = !host && workspaceId !== '' && workspaceSandboxes.isEnabled(workspaceId)
    const wantsKeep = keepShellsOn() && !host
    const notKept = wantsKeep ? await tmuxMissingReason(keptShellsProgram, loginPathSettled) : ''
    return {
      identity,
      workspaceId,
      shell,
      cols,
      rows,
      stateFile,
      markNonce,
      markNonceFile,
      env,
      secretNotice: '',
      sandboxStamp: null,
      resizePipe: null,
      portBridge: null,
      file: shell,
      args: [...integration.args, ...shellArgs],
      folder,
      cwd: folder.cwd,
      host,
      sandboxed,
      wantsKeep,
      notKept,
      tokenFile: null,
    }
  }

  return { planSpawn }
}
