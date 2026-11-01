import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { app } from 'electron'
import { parseSandboxGlobals } from '../../shared/sandbox/sandboxParse'
import { codexSocketDir } from '../agents/codexSockets'
import { controlSocketPath, keptControlSocketPath } from '../control/controlServer'
import type { PhoneFileScope } from '../gateway/workspaceFiles'
import { storePath } from '../platform/jsonStore'
import { privateTmpDir } from '../platform/privateTmp'
import { configHome, dataHome, OLD_PRODUCT_NAME } from '../platform/userDirs'
import type { PackageRequests } from '../sandboxPackages/packageRequests'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import { INTEGRATION_DIR } from '../terminal/shellIntegration'
import { shellStateDir } from '../terminal/shellStateDir'
import { keptHostChannel, keptShellsName } from '../tmux/keptPaths'
import {
  type KeptHostMeta,
  type KeptProgram,
  type KeptShells,
  SANDBOX_HOST_KIND,
} from '../tmux/keptShells'
import type { TmuxPane } from '../tmux/tmuxPane'
import { workDirForWorkspace } from '../workspaces/workspaceRegistry'
import type { DomainRequests } from './domainRequests'
import { HostPaneGrants } from './hostPanes'
import { createSandboxPorts } from './ports/sandboxPorts'
import { HOST_PROTOCOL_VERSION } from './protocol'
import { createSandboxRequests } from './sandboxRequests'
import { reachableContainerSockets, type SandboxBasePaths, srtVendorDir } from './srtConfig'
import { SandboxStore } from './store'
import { recordViolations, ViolationLog } from './violations'
import { type SandboxReadRules, visibleInSandbox } from './visibility'
import { WorkspaceSandboxes } from './workspaceSandboxes'

interface SandboxServicesDeps {
  ptys: Map<string, PtyEntry>
  keptShells: KeptShells
  readSettingsFile: () => unknown
  paneLauncherDir: () => string
  keepShellsOn: () => boolean
  keptShellsProgram: () => KeptProgram | null
}

interface WorkspaceSandboxesDeps {
  keptShells: KeptShells
  keptHostPanes: Map<string, { pane: TmuxPane; meta: KeptHostMeta }>
  sandboxViolations: ViolationLog
  readSettingsFile: () => unknown
  paneLauncherDir: () => string
  keepShellsOn: () => boolean
  keptShellsProgram: () => KeptProgram | null
  domainRequests: () => DomainRequests
  packageRequests: () => PackageRequests
}

function createWorkspaceSandboxes({
  keptShells,
  keptHostPanes,
  sandboxViolations,
  readSettingsFile,
  paneLauncherDir,
  keepShellsOn,
  keptShellsProgram,
  domainRequests,
  packageRequests,
}: WorkspaceSandboxesDeps): WorkspaceSandboxes {
  const workspaceSandboxes: WorkspaceSandboxes = new WorkspaceSandboxes({
    store: new SandboxStore(join(app.getPath('userData'), 'sandbox.json')),
    globals: () => parseSandboxGlobals((readSettingsFile() as { sandbox?: unknown }).sandbox),
    basePaths: () => {
      const base: SandboxBasePaths = {
        home: homedir(),
        dataDirs: [
          app.getPath('userData'),
          dirname(storePath('workspaces', 'global')),
          ...[
            join(app.getPath('appData'), OLD_PRODUCT_NAME),
            join(configHome(), OLD_PRODUCT_NAME),
            join(dataHome(), OLD_PRODUCT_NAME),
          ].filter((dir) => existsSync(dir)),
        ],
        runtimeDir: process.env.XDG_RUNTIME_DIR,
        agentSockets: process.env.SSH_AUTH_SOCK ? [process.env.SSH_AUTH_SOCK] : [],
        containerSockets: reachableContainerSockets(),
        socketPath: controlSocketPath(),
        codexDir: codexSocketDir(),
        srtVendorDir: srtVendorDir(app.getAppPath()),
        runtimeReads: [
          INTEGRATION_DIR,
          shellStateDir(),
          app.getAppPath(),
          dirname(process.execPath),
          paneLauncherDir(),
        ],
      }
      return keepShellsOn()
        ? { ...base, keptSocketPath: keptControlSocketPath(app.getPath('userData')) }
        : base
    },
    workDir: (workspaceId) => workDirForWorkspace(workspaceId),
    tmpRoot: privateTmpDir(`${PRODUCT_NAME}-sbx`),
    nodePath: process.execPath,
    hostScript: join(app.getAppPath(), 'out/sandbox/host.mjs'),
    onAsk: (workspaceId, host, port) =>
      domainRequests().onBlocked(workspaceSandboxes.owner(workspaceId), host, port),
    onPackageBlocked: (workspaceId, pkg, reason) =>
      packageRequests().blocked(workspaceSandboxes.owner(workspaceId), pkg, reason),
    onViolations: (workspaceId, lines) =>
      recordViolations(
        sandboxViolations,
        (path) => workspaceSandboxes.writeRefusal(workspaceId, path),
        workspaceSandboxes.owner(workspaceId),
        lines,
      ),
    kept: {
      enabled: () => keepShellsOn() && keptShellsProgram() !== null,
      tmpRoot: join(
        privateTmpDir(`${PRODUCT_NAME}-sbx`),
        `kept-${keptShellsName(app.getPath('userData'))}`,
      ),
      channel: (workspaceId) => keptHostChannel(app.getPath('userData'), workspaceId),
      claim: (workspaceId) => {
        const claimed = keptShells.claimHost(workspaceId)
        if (!claimed) return undefined
        keptHostPanes.set(workspaceId, claimed)
        return { channel: claimed.meta.channel, tmpDir: claimed.meta.tmpDir }
      },
      spawn: async (workspaceId, spec) => {
        const meta: KeptHostMeta = {
          kind: SANDBOX_HOST_KIND,
          workspaceId,
          channel: spec.channel,
          tmpDir: spec.tmpDir,
          protocol: HOST_PROTOCOL_VERSION,
          exposed: [],
        }
        const pane = await keptShells.spawnHost({
          file: spec.file,
          args: spec.args,
          cwd: spec.tmpDir,
          env: spec.env,
          meta,
        })
        keptHostPanes.set(workspaceId, { pane, meta })
      },
      stop: (workspaceId) => {
        keptHostPanes.get(workspaceId)?.pane.kill()
        keptHostPanes.delete(workspaceId)
      },
    },
  })
  return workspaceSandboxes
}

export function createSandboxServices({
  ptys,
  keptShells,
  readSettingsFile,
  paneLauncherDir,
  keepShellsOn,
  keptShellsProgram,
}: SandboxServicesDeps) {
  const keptHostPanes = new Map<string, { pane: TmuxPane; meta: KeptHostMeta }>()

  const sandboxViolations = new ViolationLog()

  const workspaceSandboxes = createWorkspaceSandboxes({
    keptShells,
    keptHostPanes,
    sandboxViolations,
    readSettingsFile,
    paneLauncherDir,
    keepShellsOn,
    keptShellsProgram,
    domainRequests: () => domainRequests,
    packageRequests: () => packageRequests,
  })

  const { paneForWorkspace, domainRequests, packageRequests } = createSandboxRequests({
    ptys,
    workspaceSandboxes,
  })

  const { syncKeptExposed, portForwarder, portRequests, scanSandboxPorts } = createSandboxPorts({
    ptys,
    workspaceSandboxes,
    keptHostPanes,
    paneForWorkspace,
  })

  function sandboxCanRead(workspaceId: string, path: string): boolean {
    return visibleInSandbox(path, workspaceSandboxes.readRules(workspaceId))
  }

  function phoneReadRules(workspaceId: string): SandboxReadRules {
    return workspaceSandboxes.isEnabled(workspaceId)
      ? workspaceSandboxes.readRules(workspaceId)
      : { denyRead: [], allowRead: [] }
  }

  function phoneFileScope(workspaceId: string): PhoneFileScope {
    const { home, dataDirs } = workspaceSandboxes.pathEnv()
    return { home, dataDirs, rules: phoneReadRules(workspaceId) }
  }

  const HOST_GRANT_TTL_MS = 120_000
  const hostPaneGrants = new HostPaneGrants({ now: Date.now, ttlMs: HOST_GRANT_TTL_MS })

  return {
    workspaceSandboxes,
    keptHostPanes,
    syncKeptExposed,
    sandboxViolations,
    sandboxCanRead,
    phoneFileScope,
    paneForWorkspace,
    domainRequests,
    portForwarder,
    packageRequests,
    portRequests,
    hostPaneGrants,
    scanSandboxPorts,
  }
}
