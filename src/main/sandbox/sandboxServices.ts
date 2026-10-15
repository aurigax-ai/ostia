import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { app } from 'electron'
import { parseSandboxGlobals } from '../../shared/sandbox/sandbox'
import { approvals } from '../approvals/approvals'
import { controlSocketPath, keptControlSocketPath } from '../control/controlServer'
import { getByPaneId } from '../control/idRegistry'
import type { PhoneFileScope } from '../gateway/workspaceFiles'
import { storePath } from '../platform/jsonStore'
import { privateTmpDir } from '../platform/privateTmp'
import { OLD_PRODUCT_NAME, configHome, dataHome } from '../platform/userDirs'
import { PackageRequests } from '../sandboxPackages/packageRequests'
import type { PtyEntry } from '../terminal/ptyRegistry'
import { INTEGRATION_DIR } from '../terminal/shellIntegration'
import { keptHostChannel, keptShellsName } from '../tmux/keptPaths'
import {
  type KeptHostMeta,
  type KeptProgram,
  type KeptShells,
  SANDBOX_HOST_KIND,
} from '../tmux/keptShells'
import type { TmuxPane } from '../tmux/tmuxServer'
import { workDirForWorkspace } from '../workspaces/workspaceRegistry'
import { DomainRequests } from './domainRequests'
import { HostPaneGrants } from './hostPanes'
import { PortForwarder, type SandboxListener, type SandboxPane } from './portForwarder'
import { PortRequests } from './portRequests'
import { HOST_PROTOCOL_VERSION } from './protocol'
import { type SandboxBasePaths, reachableContainerSockets, srtVendorDir } from './srtConfig'
import { SandboxStore } from './store'
import { ViolationLog, recordViolations } from './violations'
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

export function createSandboxServices({
  ptys,
  keptShells,
  readSettingsFile,
  paneLauncherDir,
  keepShellsOn,
  keptShellsProgram,
}: SandboxServicesDeps) {
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
        srtVendorDir: srtVendorDir(app.getAppPath()),
        runtimeReads: [
          INTEGRATION_DIR,
          privateTmpDir(`${PRODUCT_NAME}-shell-state`),
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
      domainRequests.onBlocked(workspaceSandboxes.owner(workspaceId), host, port),
    onPackageBlocked: (workspaceId, pkg, reason) =>
      packageRequests.blocked(workspaceSandboxes.owner(workspaceId), pkg, reason),
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

  const keptHostPanes = new Map<string, { pane: TmuxPane; meta: KeptHostMeta }>()

  function syncKeptExposed(workspaceId: string, listening?: readonly SandboxListener[]): void {
    const host = keptHostPanes.get(workspaceId)
    if (!host) return
    const exposed = portRequests.exposures(workspaceId, listening)
    if (JSON.stringify(exposed) === JSON.stringify(host.meta.exposed)) return
    host.meta = { ...host.meta, exposed }
    host.pane.setMeta(host.meta)
  }

  const sandboxViolations = new ViolationLog()

  function sandboxCanRead(workspaceId: string, path: string): boolean {
    try {
      const { denyRead, allowRead } = workspaceSandboxes.config(workspaceId).filesystem
      return visibleInSandbox(path, { denyRead, allowRead })
    } catch {
      return false
    }
  }

  function phoneReadRules(workspaceId: string): SandboxReadRules {
    if (!workspaceSandboxes.isEnabled(workspaceId)) return { denyRead: [], allowRead: [] }
    try {
      const { denyRead, allowRead } = workspaceSandboxes.config(workspaceId).filesystem
      return { denyRead, allowRead }
    } catch {
      return { denyRead: ['/'], allowRead: [] }
    }
  }

  function phoneFileScope(workspaceId: string): PhoneFileScope {
    const { home, dataDirs } = workspaceSandboxes.pathEnv()
    return { home, dataDirs, rules: phoneReadRules(workspaceId) }
  }

  function paneForWorkspace(workspaceId: string): string | undefined {
    for (const [paneId, entry] of ptys) {
      if (entry.workspaceId === workspaceId && entry.sandboxed) return paneId
    }
    return undefined
  }

  const domainRequests: DomainRequests = new DomainRequests({
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    blockedDomains: (workspaceId) => workspaceSandboxes.resolved(workspaceId).deniedDomains,
    ask: async ({ workspaceId, paneId, host, origin }) => {
      const pane = paneId ? getByPaneId(paneId) : undefined
      const identity = pane ?? getByPaneId(paneForWorkspace(workspaceId) ?? '')
      const queue = approvals()
      if (!identity || !queue) return 'deny'
      return queue.request({
        externalId: identity.externalId,
        windowId: identity.windowId,
        paneId: identity.paneId,
        workspaceId,
        caps: [],
        kind: 'sandbox-domain',
        subject: host,
        action: origin === 'agent' ? `ostia sandbox request-domain ${host}` : `connect to ${host}`,
        detail: '',
      })
    },
    allowWorkspace: (workspaceId, domain) => {
      workspaceSandboxes.update(workspaceId, (current) => ({
        ...current,
        domains: current.domains.includes(domain) ? current.domains : [...current.domains, domain],
      }))
    },
    allowUntilRestart: (workspaceId, domain) =>
      workspaceSandboxes.allowUntilRestart(workspaceId, domain),
    now: Date.now,
  })

  function sandboxedPanes(workspaceId: string): SandboxPane[] {
    const panes: SandboxPane[] = []
    for (const entry of ptys.values()) {
      if (entry.workspaceId === workspaceId && entry.sandboxed) {
        panes.push({ pid: entry.pty.pid, bridge: entry.portBridge })
      }
    }
    return panes
  }

  const portForwarder = new PortForwarder({
    onChange: (workspaceId) => syncKeptExposed(workspaceId),
    panesOf: sandboxedPanes,
    unixSocketsOff: (workspaceId) => !workspaceSandboxes.resolved(workspaceId).switches.unixSockets,
  })

  const PACKAGE_BATCH_MS = 600

  const packageRequests: PackageRequests = new PackageRequests({
    batchMs: PACKAGE_BATCH_MS,
    ask: async ({ workspaceId, kind, packages }) => {
      const identity = getByPaneId(paneForWorkspace(workspaceId) ?? '')
      const queue = approvals()
      if (!identity || !queue) return 'deny'
      const names = packages.map((p) => `${p.ref.name}@${p.ref.version}`)
      return queue.request({
        externalId: identity.externalId,
        windowId: identity.windowId,
        paneId: identity.paneId,
        workspaceId,
        caps: [],
        kind,
        subject: names.join(', '),
        action: `install ${names.length} package${names.length === 1 ? '' : 's'}`,
        detail: packages
          .map((p) => `${p.ref.ecosystem} ${p.ref.name}@${p.ref.version}: ${p.reason}`)
          .join('\n'),
      })
    },
    allowWorkspace: (workspaceId, key) => workspaceSandboxes.allowPackage(workspaceId, key, true),
    allowUntilRestart: (workspaceId, key) =>
      workspaceSandboxes.allowPackage(workspaceId, key, false),
  })

  const portRequests: PortRequests = new PortRequests({
    platform: process.platform,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    policy: (workspaceId) => workspaceSandboxes.resolved(workspaceId).portsPolicy,
    ask: async ({ workspaceId, paneId, port, process: owner, origin }) => {
      const pane = paneId ? getByPaneId(paneId) : undefined
      const identity = pane ?? getByPaneId(paneForWorkspace(workspaceId) ?? '')
      const queue = approvals()
      if (!identity || !queue) return 'deny'
      return queue.request({
        externalId: identity.externalId,
        windowId: identity.windowId,
        paneId: identity.paneId,
        workspaceId,
        caps: [],
        kind: 'sandbox-port',
        subject: String(port),
        action:
          origin === 'agent' ? `ostia sandbox expose ${port}` : `a server started on port ${port}`,
        detail: owner ?? '',
      })
    },
    forwarder: portForwarder,
  })

  const HOST_GRANT_TTL_MS = 120_000
  const hostPaneGrants = new HostPaneGrants({ now: Date.now, ttlMs: HOST_GRANT_TTL_MS })

  function scanSandboxPorts(): void {
    const workspaces = new Set<string>()
    for (const entry of ptys.values()) if (entry.sandboxed) workspaces.add(entry.workspaceId)
    for (const workspaceId of workspaces) {
      void portRequests.scan(workspaceId).then(() => syncKeptExposed(workspaceId))
    }
  }

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
