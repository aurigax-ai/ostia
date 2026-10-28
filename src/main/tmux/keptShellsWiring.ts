import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { appEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { app, powerMonitor } from 'electron'
import { KEEP_SHELLS_FEATURE, parseKeepShells } from '../../shared/terminal/keepShells'
import { keptControlSocketPath, listenKeptControlSocket } from '../control/controlServer'
import type { AppLog } from '../diagnostics/appLog'
import type { ProcessRegistry } from '../panes/processRegistry'
import { readSettingsFile } from '../platform/settingsFile'
import { missingRequirements, programPath } from '../platform/systemRequirements'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import { writeOstiaLauncher } from '../terminal/paneLauncher'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import { startGenerationCleanup } from '../terminal/shellIntegration'
import { handoffPaneIds, loadSnapshot } from '../workspaces/workspaceSnapshot'
import { KeptPlumbing, keptLauncherPaths } from './keptLaunchers'
import { keptShellsDir, keptShellsName } from './keptPaths'
import { watchPower } from './keptPower'
import { type KeptMeta, type KeptProcessMeta, type KeptProgram, KeptShells } from './keptShells'

interface KeptShellsWiringDeps {
  ptys: Map<string, PtyEntry>
  readSettingsFile: () => { terminal?: { keepShells?: unknown } }
  processes: () => ProcessRegistry | null
  appLog: () => AppLog | null
}

export type KeptShellsWiring = ReturnType<typeof createKeptShellsWiring>

export function createKeptShellsWiring({
  ptys,
  readSettingsFile,
  processes,
  appLog,
}: KeptShellsWiringDeps) {
  const keptShells = new KeptShells({
    dir: keptShellsDir(app.getPath('userData')),
    name: keptShellsName(app.getPath('userData')),
    program: keptShellsProgram,
    log: (event, fields) => appLog()?.info(event, fields),
  })
  let tmuxTerminal: string | null = null

  function keepShellsOn(): boolean {
    return parseKeepShells(readSettingsFile().terminal?.keepShells)
  }

  function keptShellsProgram(): KeptProgram | null {
    if (missingRequirements(KEEP_SHELLS_FEATURE).length > 0) return null
    const tmux = programPath('tmux')
    if (!tmux) return null
    return { tmux, defaultTerminal: tmuxDefaultTerminal(), env: process.env }
  }

  function tmuxDefaultTerminal(): string {
    if (tmuxTerminal === null) {
      try {
        execFileSync('infocmp', ['tmux-256color'], { stdio: 'ignore', timeout: 2000 })
        tmuxTerminal = 'tmux-256color'
      } catch {
        tmuxTerminal = 'screen-256color'
      }
    }
    return tmuxTerminal
  }

  function savedPaneIds(): Set<string> | null {
    const snapshot = loadSnapshot()
    if (!snapshot) return null
    const ids = new Set<string>()
    const workspaces = [
      ...snapshot.workspaces,
      ...(snapshot.windows ?? []).flatMap((w) => w.workspaces),
    ]
    for (const workspace of workspaces) for (const id of handoffPaneIds(workspace)) ids.add(id)
    return ids
  }

  function keptProcessOf(paneId: string): KeptProcessMeta | undefined {
    const entry = processes()?.forPane(paneId)
    if (!entry || entry.status === 'closed') return undefined
    return {
      name: entry.name,
      cmd: entry.cmd,
      ownerPaneId: entry.ownerPaneId,
      startedAt: entry.startedAt,
      status: entry.status,
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
      ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
    }
  }

  function withKeptProcess(meta: KeptMeta): KeptMeta {
    const { process: _old, ...base } = meta
    const current = keptProcessOf(meta.paneId)
    return current ? { ...base, process: current } : base
  }

  function syncKeptMeta(paneId: string): void {
    const entry = ptys.get(paneId)
    if (!entry?.kept || !entry.keptMeta) return
    entry.keptMeta = withKeptProcess(entry.keptMeta)
    entry.kept.setMeta(entry.keptMeta)
  }

  function paneLauncherDir(): string {
    return join(app.getPath('userData'), 'bin')
  }

  const keptPlumbing = new KeptPlumbing({
    launcherDir: paneLauncherDir(),
    execPath: process.execPath,
    appPath: app.getAppPath(),
    listen: () => listenKeptControlSocket(keptControlSocketPath(app.getPath('userData'))),
    warn: (code) => appLog()?.warn('launcher-write-failed', { launcher: 'kept', code }),
  })

  function keptPaneEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined || key === 'TERM') continue
      out[key] = value
    }
    const launchers = keptLauncherPaths(paneLauncherDir())
    return Object.assign(
      out,
      appEnv({
        SOCKET: keptControlSocketPath(app.getPath('userData')),
        CLI: launchers.cli,
        NODE: launchers.node,
      }),
    )
  }

  return {
    keptShells,
    keepShellsOn,
    keptShellsProgram,
    savedPaneIds,
    withKeptProcess,
    syncKeptMeta,
    paneLauncherDir,
    keptPlumbing,
    keptPaneEnv,
  }
}

interface KeptShellsStartDeps {
  keptShells: KeptShells
  savedPaneIds: () => Set<string> | null
  workspaceSandboxes: WorkspaceSandboxes
  paneLauncherDir: () => string
  services: {
    appLog: AppLog | null
  }
}

export function startKeptShells({
  keptShells,
  savedPaneIds,
  workspaceSandboxes,
  paneLauncherDir,
  services,
}: KeptShellsStartDeps) {
  watchPower(powerMonitor, keptShells)
  void keptShells
    .start(parseKeepShells(readSettingsFile().terminal?.keepShells), savedPaneIds())
    .then(() => {
      const kept = keptShells.keptHostWorkspaces()
      for (const workspaceId of kept) {
        const host = keptShells.keptHost(workspaceId)
        if (host) workspaceSandboxes.tmp.adoptKeptTmp(workspaceId, host.tmpDir)
      }
      workspaceSandboxes.tmp.sweepKeptTmp(kept)
      startGenerationCleanup(() => keptShells.waitingAgentDirs())
    })
  try {
    writeOstiaLauncher(paneLauncherDir())
  } catch (err) {
    services.appLog?.warn('launcher-write-failed', {
      launcher: 'pane',
      code: (err as NodeJS.ErrnoException).code ?? null,
    })
  }
}
