import { readFileSync } from 'node:fs'
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
import { NODE_CLI, NODE_ENTRY } from '../../shared/remote/remoteNode'
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
import { RemoteMonitor } from './remote/monitor'
import { REGISTRY_FILE, RemoteRegistry } from './remote/registry'
import { RunnerClient } from './remote/runnerClient'

const RESOLVE_TIMEOUT_MS = 5000
const HELPER_SOURCE = join(__dirname, 'assets', 'helper.sh')
const NODE_ASSETS = join(__dirname, 'assets', 'node')
const NODE_FILES = [NODE_ENTRY, NODE_CLI]

async function main(): Promise<void> {
  const ext = await connect()
  const helper = shippedHelper(readFileSync(HELPER_SOURCE))
  const hosts = new HelperHosts({ helper })
  const dataDir = readEnv('EXTENSION_DATA')
  const consent = new HelperConsent(dataDir ? join(dataDir, CONSENT_FILE) : null)
  const run = (args: string[]) => runTool('ssh', args, { timeoutMs: RESOLVE_TIMEOUT_MS })
  const sessions = new Sessions()
  const registry: RemoteRegistry = new RemoteRegistry(
    dataDir ? join(dataDir, REGISTRY_FILE) : null,
    () => void ext.startWithWindow(registry.hasWorkspaces()),
  )
  void ext.startWithWindow(registry.hasWorkspaces())
  const folders = new HelperFolders(hosts)
  onShutdown(() => hosts.closeAll())
  ext.onFiles(folders.handle)
  ext.onFolderClosed((folderId) => folders.remove(folderId))
  await ext.subscribe(['pane.closed', 'workspace.closed'], (type, payload) => {
    if (type === 'pane.closed' && 'paneId' in payload) {
      sessions.closed(payload.paneId)
      registry.forgetTab(payload.paneId)
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
  const monitor = new RemoteMonitor({
    registry,
    ping: async (host) => {
      const plan = planConnect([host])
      if (plan) await client(plan).ping()
    },
    translate: async () => translate(await ext.getLocale()),
    locale: () => ext.getLocale(),
    setSidebar: ({ workspaceId, text, tone }) =>
      ext.setSidebarItem({ key: 'remote', workspaceId, text, icon: 'server', tone, kind: 'live' }),
    setChip: (paneId, text) => ext.setPaneChip({ paneId, id: 'remote', text, tone: 'warn' }),
    clearChip: (paneId) => ext.clearPaneChip(paneId, 'remote'),
  })
  monitor.start()
  onShutdown(() => monitor.stop())
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
