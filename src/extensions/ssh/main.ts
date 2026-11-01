import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  booleanSetting,
  connect,
  createTranslator,
  onShutdown,
  runTool,
} from '@aurigax-ai/ostia-extension-sdk'
import { readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { NODE_CLI, NODE_ENTRY, REMOTE_REGISTRY_FILE } from '../../shared/remote/remoteNode'
import { spawnSsh } from './channel'
import { sshCommands } from './commands'
import { CONSENT_FILE, HelperConsent } from './consent'
import { HelperFolders, Sessions } from './folders'
import { shippedHelper } from './helper'
import { type HelperDeps, helperCommands, installedHelper } from './helperCommands'
import { HelperHosts } from './helperHosts'
import { discoverHosts } from './hosts'
import { type ConnectPlan, planConnect } from './plan'
import { nodeBundle } from './remote/bundle'
import { remoteCommands } from './remote/commands'
import { remoteFetch } from './remote/fetch'
import { type ForwardMode, HostForwards } from './remote/forwards'
import { HostLink } from './remote/link'
import { LinkHub } from './remote/linkHub'
import { RemoteMonitor } from './remote/monitor'
import { portCommands } from './remote/portCommands'
import { PortMap } from './remote/portMap'
import { portItems } from './remote/portsChip'
import { RemoteRegistry } from './remote/registry'
import { RunnerClient } from './remote/runnerClient'
import { ShellStops } from './remote/shellStops'
import { remoteStart } from './remote/start'

const RESOLVE_TIMEOUT_MS = 5000
const PORT_MAP_FILE = 'remote-ports.json'
const GIT_TIMEOUT_MS = 300_000
const GIT_OUTPUT_MAX = 6 * 1024 * 1024
const HELPER_SOURCE = join(__dirname, 'assets', 'helper.sh')
const NODE_ASSETS = join(__dirname, 'assets', 'node')
const NODE_FILES = [NODE_ENTRY, NODE_CLI]

function localPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

async function main(): Promise<void> {
  const ext = await connect()
  const helper = shippedHelper(readFileSync(HELPER_SOURCE))
  const hosts = new HelperHosts({ helper })
  const dataDir = readEnv('EXTENSION_DATA')
  const consent = new HelperConsent(dataDir ? join(dataDir, CONSENT_FILE) : null)
  const run = (args: string[]) => runTool('ssh', args, { timeoutMs: RESOLVE_TIMEOUT_MS })
  const sessions = new Sessions()
  const registry: RemoteRegistry = new RemoteRegistry(
    dataDir ? join(dataDir, REMOTE_REGISTRY_FILE) : null,
    () => {
      void ext.startWithWindow(registry.hasWorkspaces())
      for (const host of registry.hosts()) void monitor.seed(host)
      hub.sync()
    },
  )
  void ext.startWithWindow(registry.hasWorkspaces())
  const folders = new HelperFolders(hosts)
  onShutdown(() => hosts.closeAll())
  ext.onFiles(folders.handle)
  ext.onFolderClosed((folderId) => folders.remove(folderId))
  await ext.subscribe(['pane.closed', 'workspace.closed'], (type, payload) => {
    if (type === 'pane.closed' && 'paneId' in payload) {
      sessions.closed(payload.paneId)
      const tab = registry.tab(payload.paneId)
      registry.forgetTab(payload.paneId)
      if (tab?.shell) void shellStops.stop(tab.host, tab.pane)
    }
    if (type === 'workspace.closed' && 'workspaceId' in payload) {
      registry.forgetWorkspace(payload.workspaceId)
    }
  })
  const translate = createTranslator()
  const helperDeps: HelperDeps = {
    translate,
    run,
    confirm: (req) => ext.confirm(req),
    enabled: async () => booleanSetting(await ext.getSettings(), 'remoteHelper', true),
    consent,
    hosts,
    helper,
    sessions,
    folders,
    openFolder: (opts) => ext.openFolder(opts),
    closeFolder: (folderId) => ext.closeFolder(folderId),
  }
  const bundle = nodeBundle(
    NODE_FILES.map((name) => ({ name, data: readFileSync(join(NODE_ASSETS, name)) })),
  )
  const client = (plan: ConnectPlan) => new RunnerClient(plan, bundle)
  const git = (args: string[], cwd: string) =>
    runTool('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS, maxOutput: GIT_OUTPUT_MAX })
  const shellStops = new ShellStops(async (host, pane) => {
    const plan = planConnect([host])
    if (plan) await client(plan).stop(pane)
  })
  const monitor = new RemoteMonitor({
    registry,
    translate: async () => translate(await ext.getLocale()),
    locale: () => ext.getLocale(),
    setSidebar: ({ workspaceId, text, tone }) =>
      ext.setSidebarItem({ key: 'remote', workspaceId, text, icon: 'server', tone, kind: 'live' }),
    setChip: (paneId, text) => ext.setPaneChip({ paneId, id: 'remote', text, tone: 'warn' }),
    clearChip: (paneId) => ext.clearPaneChip(paneId, 'remote'),
  })
  const portMap = new PortMap(dataDir ? join(dataDir, PORT_MAP_FILE) : null)
  const portMode = async (): Promise<ForwardMode> =>
    (await ext.getSettings()).portForwarding === 'manual' ? 'manual' : 'auto'
  const publishPorts = (host: string): void => {
    const rows = hub.forwards(host)?.rows() ?? []
    for (const workspaceId of registry.workspacesOn(host)) {
      if (rows.length === 0) void ext.clearWorkspaceChip(workspaceId, 'ports')
      else {
        void ext.setWorkspaceChip({
          workspaceId,
          id: 'ports',
          icon: 'plugs',
          text: String(rows.length),
          tone: 'neutral',
          items: portItems(rows),
        })
      }
    }
  }
  const hub: LinkHub = new LinkHub(registry, (host) => {
    const plan = planConnect([host])
    if (!plan) return null
    const forwards = new HostForwards({
      host,
      plan,
      spawn: spawnSsh,
      map: portMap,
      mode: portMode,
      isFree: localPortFree,
      changed: () => publishPorts(host),
    })
    const link = new HostLink({
      host,
      plan,
      bundle,
      spawn: spawnSsh,
      remoteMail: (request) => ext.remoteMail(request),
      forwards,
      onState: (online, last) => {
        void monitor.state(host, online, last)
        if (online) void shellStops.retry(host)
      },
    })
    return { link, forwards }
  })
  monitor.start()
  for (const host of registry.hosts()) void monitor.seed(host)
  hub.sync()
  onShutdown(() => {
    monitor.stop()
    hub.stopAll()
  })
  await ext.registerCommands({
    ...sshCommands({
      translate,
      discover: () => discoverHosts(homedir()),
      run,
      confirm: (req) => ext.confirm(req),
      openTerminal: (opts) => ext.openTerminal(opts),
      shellIntegration: async () =>
        booleanSetting(await ext.getSettings(), 'shellIntegration', true),
      sessionOpened: (paneId, plan) => sessions.opened(paneId, plan),
      installedHelper: async (plan) =>
        (await helperDeps.enabled()) ? installedHelper(plan, helperDeps) : null,
    }),
    ...helperCommands(helperDeps),
    'remote-start': remoteStart({
      translate,
      confirm: (req) => ext.confirm(req),
      consent,
      openTerminal: (opts) => ext.openTerminal(opts),
      client,
      registry,
      git,
    }),
    'remote-fetch': remoteFetch({
      translate,
      confirm: (req) => ext.confirm(req),
      consent,
      client,
      git,
      openDiff: (diff) => ext.openDiff(diff),
    }),
    ...portCommands({ registry, forwards: (host) => hub.forwards(host) }),
    ...remoteCommands({
      translate,
      confirm: (req) => ext.confirm(req),
      openTerminal: (opts) => ext.openTerminal(opts),
      client,
      bundle,
      consent,
      registry,
    }),
  })
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
