import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { appEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { type BrowserWindow, app } from 'electron'
import { shellArgv, shellName } from '../../../shared/terminal/terminalShell'
import type { PtyAttachResult, PtySpawnOptions } from '../../../shared/types'
import type { ArtifactFolders } from '../../artifacts/artifactFolders'
import { controlSocketPath } from '../../control/controlServer'
import { getByPaneId, panesOwnedBy, registerPane } from '../../control/idRegistry'
import type { AppLog } from '../../diagnostics/appLog'
import type { Telemetry } from '../../diagnostics/telemetry'
import type { PaneProcess } from '../../panes/paneProcess'
import { privateTmpDir } from '../../platform/privateTmp'
import { loginPathSettled } from '../../platform/toolPath'
import { attachWorkspace } from '../../sandbox/attachWorkspace'
import type { HostPaneGrants } from '../../sandbox/hostPanes'
import { hiddenHomeNotice, sandboxFailureBanner } from '../../sandbox/spawnBanner'
import type { WorkspaceSandboxes } from '../../sandbox/workspaceSandboxes'
import { TMUX_MISSING, keepShellsNotice } from '../../tmux/keepShellsBanner'
import type { KeptPlumbing } from '../../tmux/keptLaunchers'
import type { KeptReattach } from '../../tmux/keptReattach'
import type { KeptMeta } from '../../tmux/keptShells'
import type { KeptProgram, KeptShells } from '../../tmux/keptShells'
import type { TmuxPane } from '../../tmux/tmuxServer'
import type { ScratchFolders } from '../../workspaces/scratchFolders'
import { takeRestoredScrollback } from '../../workspaces/workspaceSnapshot'
import { CoalescedOutput } from '../ptyFlow'
import type { Subscriber, SubscriberRole } from '../ptySession'
import { HIBERNATE_SEAM, RESTORE_SEAM } from '../screenMirror'
import { shellIntegrationSpawnOptions } from '../shellIntegration'
import { spawnFolder } from '../spawnCwd'
import { PTY_TERM_NAME, paneShellEnv, withPaneToken } from '../terminalType'
import type { PtyEntry, PtyRegistry } from './ptyRegistry'
import type { SandboxSpawn, SpawnPlan } from './ptySandboxSpawn'

interface PtyAttachDeps {
  ptys: Map<string, PtyEntry>
  windows: Map<string, BrowserWindow>
  movingPanes: Set<string>
  recoveryHeld: Set<string>
  hibernatedPanes: Set<string>
  keptShells: KeptShells
  keptPlumbing: KeptPlumbing
  scratchFolders: ScratchFolders
  artifactFolders: ArtifactFolders
  hostPaneGrants: HostPaneGrants
  workspaceSandboxes: WorkspaceSandboxes
  readSettingsFile: () => { terminal?: { shell?: unknown }; agents?: { hooks?: unknown } }
  paneLauncherDir: () => string
  keepShellsOn: () => boolean
  keptShellsProgram: () => KeptProgram | null
  withKeptProcess: (meta: KeptMeta) => KeptMeta
  keptPaneEnv: (env: NodeJS.ProcessEnv) => Record<string, string>
  loadPty: PtyRegistry['loadPty']
  trackPty: PtyRegistry['trackPty']
  feedPty: PtyRegistry['feedPty']
  releaseMergedSandbox: (workspaceId: string, exiting?: PtyEntry) => void
  reattachKept: KeptReattach['reattachKept']
  spawnSandboxed: SandboxSpawn['spawnSandboxed']
  telemetry: () => Telemetry | null
  appLog: () => AppLog | null
}

export type PtyAttach = ReturnType<typeof createPtyAttach>

export function createPtyAttach({
  ptys,
  windows,
  movingPanes,
  recoveryHeld,
  hibernatedPanes,
  keptShells,
  keptPlumbing,
  scratchFolders,
  artifactFolders,
  hostPaneGrants,
  workspaceSandboxes,
  readSettingsFile,
  paneLauncherDir,
  keepShellsOn,
  keptShellsProgram,
  withKeptProcess,
  keptPaneEnv,
  loadPty,
  trackPty,
  feedPty,
  releaseMergedSandbox,
  reattachKept,
  spawnSandboxed,
  telemetry,
  appLog,
}: PtyAttachDeps) {
  const SANDBOX_LOST_WHILE_AWAY = `its sandbox ended while ${PRODUCT_DISPLAY_NAME} was closed`

  function shellFamily(shell: string): string {
    const name = basename(shell).toLowerCase()
    return name === 'zsh' || name === 'bash' || name === 'fish' ? name : 'other'
  }

  function windowShown(wid: string): boolean {
    const win = windows.get(wid)
    return win !== undefined && !win.isDestroyed() && win.isVisible() && !win.isMinimized()
  }

  function subscriberFor(
    e: Electron.IpcMainInvokeEvent,
    paneId: string,
    opts: PtySpawnOptions,
    subId: string,
  ): (entry: PtyEntry) => Subscriber {
    return (entry: PtyEntry): Subscriber => {
      const role: SubscriberRole = opts.role === 'observer' ? 'observer' : 'owner'
      const lane = role === 'owner' ? entry.flow.open(subId, () => windowShown(subId)) : null
      const output = new CoalescedOutput((data) => {
        if (e.sender.isDestroyed()) return
        e.sender.send(`pty:data:${paneId}`, data)
        lane?.sent(data.length)
      })
      return {
        id: subId,
        role,
        send: (data) => output.push(data),
        flush: () => output.flush(),
        close: () => {
          output.close()
          lane?.close()
        },
      }
    }
  }

  function attachExisting(
    existing: PtyEntry,
    e: Electron.IpcMainInvokeEvent,
    paneId: string,
    opts: PtySpawnOptions,
    mkSub: (entry: PtyEntry) => Subscriber,
  ): PtyAttachResult {
    const subId = String(e.sender.id)
    if (existing.killTimer) {
      clearTimeout(existing.killTimer)
      existing.killTimer = null
    }
    movingPanes.delete(paneId)
    recoveryHeld.delete(paneId)
    existing.subs.set(subId, e.sender)
    existing.session.addLiveSubscriber(mkSub(existing))
    const { data, cursor, dropped } = existing.session.since(opts.sinceCursor ?? 0)
    return {
      created: false,
      buffer: data,
      cursor,
      dropped,
      shell: shellName(existing.shell) || undefined,
      sandboxed: existing.sandboxed,
      ...(existing.sandboxStamp ? { sandboxStamp: existing.sandboxStamp } : {}),
      ...(existing.kept ? { kept: true } : {}),
      cols: existing.pty.cols,
      rows: existing.pty.rows,
    }
  }

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
    const plan = await planSpawn(paneId, opts, subId)
    if ('created' in plan) return plan
    if (plan.sandboxed) {
      const failed = await spawnSandboxed(paneId, plan)
      if (failed) return failed
    }
    if (ptys.has(paneId)) {
      plan.portBridge?.close()
      return attachPty(e, paneId, opts)
    }
    if (plan.wantsKeep && !plan.notKept && !plan.tokenFile) {
      plan.tokenFile = keptShells.writeToken(paneId, plan.identity.token)
    }
    plan.env = withPaneToken(plan.env, plan.identity.token, plan.tokenFile)
    const spawned = plan.wantsKeep && !plan.notKept ? await spawnKept(paneId, plan) : null
    if (spawned && ptys.has(paneId)) {
      spawned.kept?.kill()
      return attachPty(e, paneId, opts)
    }
    return startTracked(e, paneId, mod, plan, spawned ?? { kept: null, keptMeta: null }, mkSub)
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
        buffer: sandboxFailureBanner('the pane belongs to another workspace', []),
        cursor: 0,
        dropped: false,
      }
    }
    const identity = registerPane({ windowId: subId, workspaceId: resolved.workspaceId, paneId })
    const workspaceId = identity.workspaceId
    const integration = shellIntegrationSpawnOptions(
      shell,
      process.env,
      opts.ostiaPrompt ?? null,
      scratchFolders.historyFile(workspaceId),
    )
    const cols = opts.cols || 80
    const rows = opts.rows || 24
    const stateFile = join(privateTmpDir(`${PRODUCT_NAME}-shell-state`), randomUUID())
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
    if (wantsKeep && !keptShellsProgram()) await loginPathSettled()
    const notKept = wantsKeep && !keptShellsProgram() ? TMUX_MISSING : ''
    return {
      identity,
      workspaceId,
      shell,
      cols,
      rows,
      stateFile,
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

  async function spawnKept(
    paneId: string,
    plan: SpawnPlan,
  ): Promise<{ kept: TmuxPane | null; keptMeta: KeptMeta | null }> {
    const {
      identity,
      workspaceId,
      shell,
      cols,
      rows,
      stateFile,
      env,
      sandboxStamp,
      resizePipe,
      portBridge,
      file,
      args,
      cwd,
      sandboxed,
    } = plan
    let kept: TmuxPane | null = null
    keptPlumbing.ensure()
    let keptMeta: KeptMeta | null = withKeptProcess({
      paneId,
      externalId: identity.externalId,
      workspaceId,
      shell,
      stateFile,
      spawnPath: env.PATH ?? '',
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
      plan.notKept = err instanceof Error ? err.message : String(err)
      keptMeta = null
      appLog()?.info('kept-spawn-failed', { pane: paneId, reason: plan.notKept })
    }
    return { kept, keptMeta }
  }

  function startTracked(
    e: Electron.IpcMainInvokeEvent,
    paneId: string,
    mod: typeof import('node-pty'),
    plan: SpawnPlan,
    { kept, keptMeta }: { kept: TmuxPane | null; keptMeta: KeptMeta | null },
    mkSub: (entry: PtyEntry) => Subscriber,
  ): PtyAttachResult {
    const subId = String(e.sender.id)
    const {
      workspaceId,
      shell,
      cols,
      rows,
      stateFile,
      env,
      secretNotice,
      sandboxStamp,
      resizePipe,
      portBridge,
      file,
      args,
      folder,
      cwd,
      host,
      sandboxed,
      notKept,
      tokenFile,
    } = plan
    const pty: PaneProcess =
      kept ??
      mod.spawn(file, args, {
        name: PTY_TERM_NAME,
        cols,
        rows,
        cwd,
        env,
      })
    const entry = trackPty(paneId, pty, {
      kept,
      keptMeta,
      cols,
      rows,
      subs: new Map([[subId, e.sender]]),
      spawnPath: env.PATH ?? '',
      stateFile,
      keepAlive: false,
      workspaceId,
      sandboxed,
      shell,
      sandboxStamp,
      portBridge,
    })
    const { session } = entry
    if (tokenFile) entry.exitListeners.add(() => keptShells.removeToken(paneId))
    if (sandboxed) {
      entry.exitListeners.add(() => {
        if (resizePipe) rmSync(resizePipe, { force: true })
        portBridge?.close()
        void workspaceSandboxes.cleanup(workspaceId)
        releaseMergedSandbox(workspaceId, entry)
      })
    }

    const history = takeRestoredScrollback(paneId)
    if (history) appLog()?.info('scrollback-replay', { pane: paneId, chars: history.length })
    const seam = hibernatedPanes.delete(paneId) ? HIBERNATE_SEAM : RESTORE_SEAM
    if (history) feedPty(entry, `${history}${seam}`)
    if (secretNotice) feedPty(entry, secretNotice)
    if (notKept) feedPty(entry, keepShellsNotice(notKept))
    if (sandboxed && workspaceSandboxes.claimHomeNotice(workspaceId)) {
      const notice = hiddenHomeNotice()
      if (notice) feedPty(entry, notice)
    }
    if (history) entry.mirror.markRestored(history)

    pty.onData((d) => feedPty(entry, d))
    pty.onExit(({ exitCode }) => session.exit(exitCode))
    const { data, cursor, dropped } = session.since(0)
    session.addLiveSubscriber(mkSub(entry))
    if (folder.missing) telemetry()?.count('terminal', 'spawn_failure', 'cwd-missing')
    return {
      created: true,
      buffer: data,
      cursor,
      dropped,
      shell: shellName(shell) || undefined,
      sandboxed,
      host,
      ...(sandboxStamp ? { sandboxStamp } : {}),
      ...(kept ? { kept: true } : {}),
      ...(folder.missing ? { cwdMissing: true } : {}),
    }
  }

  return { attachPty }
}
