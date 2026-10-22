import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { appEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { app } from 'electron'
import type { PtyAttachResult, PtySpawnOptions } from '../../../shared/terminal/ptyApi'
import { shellArgv } from '../../../shared/terminal/terminalShell'
import { codexSocketPath, registerCodexSocket } from '../../agents/codexSockets'
import { workspaceFolder } from '../../agents/extensionAgents'
import { registerMailFlag } from '../../agents/mailFlag'
import type { ArtifactFolders } from '../../artifacts/artifactFolders'
import { controlSocketPath } from '../../control/controlServer'
import type { PaneIdentity } from '../../control/idRegistry'
import { getByPaneId, registerPane } from '../../control/idRegistry'
import type { Telemetry } from '../../diagnostics/telemetry'
import { privateTmpDir } from '../../platform/privateTmp'
import { loginPathSettled } from '../../platform/toolPath'
import { attachWorkspace } from '../../sandbox/attachWorkspace'
import type { HostPaneGrants } from '../../sandbox/hostPanes'
import type { PortBridge } from '../../sandbox/ports/portBridge'
import { sandboxFailureBanner } from '../../sandbox/spawnBanner'
import type { WorkspaceSandboxes } from '../../sandbox/workspaceSandboxes'
import { tmuxMissing } from '../../tmux/keepShellsBanner'
import type { KeptProgram } from '../../tmux/keptShells'
import { tmuxMissingReason } from '../../tmux/keptSpawn'
import type { ScratchFolders } from '../../workspaces/scratchFolders'
import { workDirForWorkspace } from '../../workspaces/workspaceRegistry'
import { markNonceFileFor, writeMarkNonce } from '../markNonce'
import { integrationNotLoadedNotice, type PaneBannerText } from '../paneBanner'
import {
  integrationFailure,
  retainAgentDir,
  type ShellIntegrationSpawn,
  sendsMarkNonce,
  shellIntegrationSpawnOptions,
} from '../shellIntegration'
import type { SpawnFolder } from '../spawnCwd'
import { sandboxCwd, spawnFolder } from '../spawnCwd'
import { paneShellEnv } from '../terminalType'

export interface SpawnPlan {
  identity: PaneIdentity
  workspaceId: string
  shell: string
  cols: number
  rows: number
  stateFile: string | null
  markNonce: string | null
  markNonceFile: string | null
  env: Record<string, string>
  secretNotice: string
  integrationNotice: string
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
  agentDir: string | null
}

interface ShellFiles {
  stateFile: string | null
  markNonceFile: string | null
  markNonce: string | null
  failure: string | null
}

function shellFiles(shell: string): ShellFiles {
  const name = randomUUID()
  try {
    const stateFile = join(privateTmpDir(`${PRODUCT_NAME}-shell-state`), name)
    const markNonceFile = sendsMarkNonce(shell) ? markNonceFileFor(stateFile) : null
    const markNonce = markNonceFile ? writeMarkNonce(markNonceFile) : null
    return { stateFile, markNonceFile, markNonce, failure: null }
  } catch (err) {
    return {
      stateFile: null,
      markNonceFile: null,
      markNonce: null,
      failure: integrationFailure(err),
    }
  }
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
  bannerText: () => PaneBannerText
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
  bannerText,
}: SpawnPlannerDeps) {
  function workspaceDir(workspaceId: string, sandboxed: boolean): string | null {
    const dir = workspaceFolder(
      sandboxed ? workspaceSandboxes.workDir(workspaceId) : workDirForWorkspace(workspaceId),
      homedir(),
    )
    if (!dir) return null
    return sandboxed ? sandboxCwd(dir, dir) : dir
  }

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
        buffer: sandboxFailureBanner(bannerText(), bannerText().otherWorkspace, []),
        cursor: 0,
        dropped: false,
      }
    }
    const identity = registerPane({ windowId: subId, workspaceId: resolved.workspaceId, paneId })
    const workspaceId = identity.workspaceId
    const { stateFile, markNonceFile, markNonce, failure } = shellFiles(shell)
    const mailFile = stateFile ? `${stateFile}.mail` : null
    if (mailFile) registerMailFlag(identity.externalId, mailFile)
    const host = opts.hostToken ? hostPaneGrants.consume(opts.hostToken) : false
    const sandboxed = !host && workspaceId !== '' && workspaceSandboxes.isEnabled(workspaceId)
    const codexSock = sandboxed ? null : codexSocketPath()
    if (codexSock) registerCodexSocket(identity.externalId, codexSock)
    const integration: ShellIntegrationSpawn = failure
      ? { args: [], env: {}, agentDir: null, notLoaded: failure }
      : shellIntegrationSpawnOptions(
          shell,
          process.env,
          opts.ostiaPrompt ?? null,
          scratchFolders.historyFile(workspaceId),
          markNonceFile,
        )
    if (integration.agentDir) retainAgentDir(paneId, integration.agentDir)
    if (integration.notLoaded) {
      telemetry()?.count('terminal', 'spawn_failure', 'integration-not-loaded')
    }
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
        ...(stateFile && mailFile ? { SHELL_STATE: stateFile, MAIL_FILE: mailFile } : {}),
        ...(codexSock ? { CODEX_SOCK: codexSock } : {}),
      }),
      agentHooks: settings.agents?.hooks,
      artifactsDir: workspaceId ? artifactFolders.ensure(workspaceId) : null,
      workspaceDir: workspaceDir(workspaceId, sandboxed),
      launcherDir: paneLauncherDir(),
    })
    const folder = spawnFolder(opts.cwd)
    const wantsKeep = keepShellsOn() && !host
    const notKept = wantsKeep
      ? await tmuxMissingReason(keptShellsProgram, loginPathSettled, tmuxMissing(bannerText()))
      : ''
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
      integrationNotice: integration.notLoaded
        ? integrationNotLoadedNotice(bannerText(), integration.notLoaded)
        : '',
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
      agentDir: integration.agentDir,
    }
  }

  return { planSpawn }
}
