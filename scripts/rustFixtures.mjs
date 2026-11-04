import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const root = process.cwd()
const out = join(root, 'test/fixtures/rust')
const contractData = join(root, 'crates/contract/data')
const work = mkdtempSync(join(tmpdir(), 'rust-fixtures-'))

const ENTRY = `
export { ParkedStore } from './src/main/park/parkedStore'
export { ServerOverrides } from './src/main/lsp/serverOverrides'
export { SandboxStore } from './src/main/sandbox/store'
export { ViewStateStore } from './src/main/git/viewState'
export { saveJson, saveJsonAsync } from './src/main/platform/jsonStore'
export { ostiaLauncherScript } from './src/main/terminal/paneLauncher'
export { errorBanner, integrationNotLoadedNotice } from './src/main/terminal/paneBanner'
export { en, zhHant, mergeCatalog } from './src/shared/app/dict'
export { keepShellsNotice, tmuxMissing } from './src/main/tmux/keepShellsBanner'
export { hiddenHomeNotice, sandboxFailureBanner } from './src/main/sandbox/spawnBanner'
export { SandboxTmpDirs } from './src/main/sandbox/sandboxTmp'
export { parseSnapshot } from './src/main/workspaces/workspaceSnapshot'
export { scrollbackToSave } from './src/main/workspaces/savedScrollback'
export { USAGE_TABLE } from './src/cli/common/usageTable'
export * as bus from './src/main/agents/busStore'
export { encodeViewerSelection } from './packages/extension-sdk/src/contract/viewerSelection'
export { createHeadlessTerminal } from './src/shared/terminal/ghosttyHeadless'
export { createTelemetry } from './src/main/diagnostics/telemetry'
export { ViewStore } from './src/main/workspaces/viewHost'
export { OpenFileGrants } from './src/main/files/openFileGrants'
export { ExtensionStore } from './src/main/extensions/extensionStore'
export { ExtensionLaunches } from './src/main/extensions/extensionLaunches'
export { ExtensionConnections } from './src/main/extensions/extensionConnections'
export * as claudeIntegration from './src/main/terminal/claudeIntegration'
export * as agyIntegration from './src/main/terminal/agyIntegration'
export * as gatewayDevices from './src/main/gateway/devices'
export * as gatewayPairing from './src/main/gateway/pairing'
export { checkCode } from './src/main/gateway/pairCheck'
export { createChatSessionStore } from './src/main/chat/chatSessions'
export { ChatToolGrants } from './src/main/chat/chatToolGrants'
export { diffLines, diffWordsWithSpace } from 'diff'
export { BUILTIN_COLOR_SCHEMES } from './src/renderer/lib/colorSchemes/builtinColorSchemes'
export * as uiFonts from './src/renderer/lib/theme/uiFonts'
export * as browserEditorSettings from './src/renderer/lib/settings/browserEditorSettings'
export * as agentSchema from './src/renderer/lib/settings/agentSchema'
`

const rawPlugin = {
  name: 'raw',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: new URL(args.path.replace(/\?raw$/, ''), `file://${args.resolveDir}/`).pathname,
      namespace: 'raw',
    }))
    b.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({
      contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf8'))}`,
      loader: 'js',
    }))
  },
}

const bundle = join(work, 'bundle.cjs')
const electronStub = join(work, 'electron-stub.cjs')
writeFileSync(electronStub, 'module.exports = {}\n')
await build({
  stdin: { contents: ENTRY, resolveDir: root, loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle,
  loader: { '.wasm': 'binary' },
  alias: { electron: electronStub },
  plugins: [rawPlugin],
  logLevel: 'error',
})
const {
  ParkedStore,
  ServerOverrides,
  SandboxStore,
  saveJson,
  saveJsonAsync,
  ostiaLauncherScript,
  errorBanner,
  integrationNotLoadedNotice,
  keepShellsNotice,
  tmuxMissing,
  hiddenHomeNotice,
  sandboxFailureBanner,
  SandboxTmpDirs,
  en,
  zhHant,
  mergeCatalog,
  parseSnapshot,
  scrollbackToSave,
  ViewStateStore,
  USAGE_TABLE,
  bus,
  encodeViewerSelection,
  createHeadlessTerminal,
  createTelemetry,
  ViewStore,
  OpenFileGrants,
  ExtensionStore,
  ExtensionLaunches,
  ExtensionConnections,
  claudeIntegration,
  agyIntegration,
  gatewayDevices,
  gatewayPairing,
  checkCode,
  createChatSessionStore,
  ChatToolGrants,
  diffLines,
  diffWordsWithSpace,
  BUILTIN_COLOR_SCHEMES,
  uiFonts,
  browserEditorSettings,
  agentSchema,
} = createRequire(import.meta.url)(bundle)

const STORE_VALUE = {
  v: 1,
  text: 'é 日本語 😀 "quoted" back\\slash   \u001b tab\t',
  count: 1700000000123,
  fraction: 1.5,
  negative: -7,
  flag: true,
  none: null,
  empty: [],
  blank: {},
  z: { b: [1, [2, { deep: 'x' }]], a: 'keeps the order' },
}

mkdirSync(out, { recursive: true })
saveJson(join(out, 'json-store-pretty.json'), STORE_VALUE)
await saveJsonAsync(join(out, 'json-store-compact.json'), STORE_VALUE)

const NUMBER_TEXTS = [
  '',
  ' ',
  '\t\n',
  '12',
  '12abc',
  '1.5',
  ' 1.5\n',
  '0x10',
  '0X1f',
  '0o17',
  '0O17',
  '0b101',
  '0B11',
  '-0x10',
  '+0x10',
  '0x',
  '0o8',
  '0b2',
  '0xg',
  '1e3',
  '1E3',
  '1e-3',
  '1e+3',
  '1e',
  '1e+',
  'e5',
  '.5',
  '5.',
  '5.e3',
  '.e3',
  '.',
  '-.5',
  '+.5',
  '-',
  '+',
  '+5',
  '-5',
  '-0',
  '0',
  '00012',
  '--5',
  '+-5',
  'Infinity',
  '+Infinity',
  '-Infinity',
  'infinity',
  'INFINITY',
  'inf',
  'nan',
  'NaN',
  '1_000',
  '1,000',
  '1 2',
  '1.5.2',
  '1d',
  '1f',
  '0x1p3',
  '١٢',
  ' 12﻿',
  '\u008512',
  '​12',
  ' 1 ',
  '9007199254740991',
  '9007199254740992',
  '9007199254740993',
  '9007199254740995',
  '18446744073709551616',
  '123456789012345678901234567890',
  '1e999',
  '-1e999',
  '1e-999',
  '0.1',
  '0.30000000000000004',
  '1.7976931348623157e308',
  '5e-324',
  '2.2250738585072014e-308',
  '0x1fffffffffffff',
  '0x20000000000001',
  '0x20000000000003',
  '0x20000000000005',
  '0x100000000000008000000000000000001',
  '0xffffffffffffffffffffffffffffffffffffffff',
  '0x000000000000000000000000000000000000000000000001',
  `0x${'f'.repeat(300)}`,
  `0b${'1'.repeat(60)}`,
]

function float64Hex(value) {
  const buffer = Buffer.alloc(8)
  buffer.writeDoubleBE(value)
  return buffer.toString('hex')
}

writeFileSync(
  join(out, 'js-number.json'),
  `${JSON.stringify(
    NUMBER_TEXTS.map((text) => ({ text, bits: float64Hex(Number(text)) })),
    null,
    1,
  )}\n`,
)

const LOCALE_WORDS = [
  'Zeta',
  'alpha',
  'a_b',
  'a-b',
  'a/b',
  'ab',
  'a b',
  'A',
  'a',
  'B',
  'b',
  'résumé',
  'resume',
  'Résumé',
  'ä',
  'z',
  'Z',
  '10',
  '9',
  '',
  'origin/main',
  'feature/x',
  'Feature/x',
  '日本語',
  '😀',
  'ss',
  'ß',
]

const LOCALE_ROWS = []
for (const a of LOCALE_WORDS) {
  for (const b of LOCALE_WORDS) LOCALE_ROWS.push({ a, b, order: Math.sign(a.localeCompare(b)) })
}
writeFileSync(join(out, 'locale-compare.json'), `${JSON.stringify(LOCALE_ROWS)}\n`)

const times = [1700000000123, 9, 1.5]
const parked = join(work, 'parked-sessions.json')
const store = new ParkedStore(parked, () => times.shift())
store.park({
  workspaceId: 'w1',
  resume: { agent: 'claude', id: 's1', cwd: '/home/u/api', args: ['--model', 'opus'] },
  title: 'export é',
  titlePinned: true,
  summary: 'stopped at the retry test',
})
const gone = store.park({ workspaceId: 'w1', resume: { agent: 'codex', id: 's2' }, title: 'gone' })
store.park({ workspaceId: 'w2', resume: { agent: 'agy', id: 's3' }, title: 'third' })
writeFileSync(join(out, 'parked-sessions-before.json'), readFileSync(parked))
store.remove(gone.record.id)
writeFileSync(join(out, 'parked-sessions-after.json'), readFileSync(parked))
const overridesFile = join(work, 'language-server-programs.json')
const overrides = new ServerOverrides(overridesFile)
overrides.choose('ext/ls', { path: '/bin/sh', args: ['--stdio', '--log=é'] })
overrides.choose('ext/two', { path: '/bin/sh' })
overrides.choose('other/one', { path: '/bin/sh', args: ['-x'] })
writeFileSync(join(out, 'language-server-programs-before.json'), readFileSync(overridesFile))
overrides.forgetExtension('ext')
writeFileSync(join(out, 'language-server-programs-after.json'), readFileSync(overridesFile))
const extensionsFile = join(work, 'extensions.json')
const extensionStore = new ExtensionStore(extensionsFile)
extensionStore.set('demo', {
  enabled: true,
  approved: ['notify', 'shell'],
  approvedKinds: ['demo.grid:view:default:*.csv'],
  serversOff: ['pyright'],
})
extensionStore.set('plain', { enabled: false, approved: null })
extensionStore.set('gone', { enabled: true, approved: [] })
writeFileSync(join(out, 'extensions-before.json'), readFileSync(extensionsFile))
extensionStore.delete('gone')
writeFileSync(join(out, 'extensions-after.json'), readFileSync(extensionsFile))
const launchesFile = join(work, 'extension-launches.json')
const launches = new ExtensionLaunches(launchesFile)
launches.set('graphs', true)
launches.set('activity', true)
launches.set('beta', true)
writeFileSync(join(out, 'extension-launches-before.json'), readFileSync(launchesFile))
launches.set('activity', false)
writeFileSync(join(out, 'extension-launches-after.json'), readFileSync(launchesFile))
const connectionsFile = join(work, 'extension-connections.json')
const connectionKinds = [
  {
    kind: 'http',
    title: 'HTTP API',
    fields: [
      { key: 'baseUrl', title: 'Base URL', type: 'string', required: true },
      { key: 'auth', title: 'Auth', type: 'enum', enum: ['none', 'bearer'], default: 'bearer' },
      { key: 'header', title: 'Header', type: 'string' },
    ],
    secrets: [{ key: 'secret', title: 'Token' }],
  },
]
const connections = new ExtensionConnections(connectionsFile, () => undefined)
for (const name of ['z', 'api', 'apiary', 'a-b', 'ab', 'a0', 'c10', 'c2', 'x-1', 'x1', 'x-a']) {
  connections.save('graphs', connectionKinds, {
    name,
    kind: 'http',
    fields: { baseUrl: `https://${name}.example.test`, ...(name === 'ab' ? { header: 'X-Key' } : {}) },
  })
}
connections.save('other', connectionKinds, {
  name: 'solo',
  kind: 'http',
  fields: { baseUrl: 'https://solo.example.test', auth: 'none' },
})
writeFileSync(join(out, 'extension-connections-before.json'), readFileSync(connectionsFile))
writeFileSync(
  join(out, 'extension-connections-order.json'),
  `${JSON.stringify(connections.names('graphs', connectionKinds).map((c) => c.name))}\n`,
)
connections.remove('graphs', 'a0')
connections.save('graphs', connectionKinds, {
  name: 'api',
  kind: 'http',
  fields: { baseUrl: 'https://api.changed.test', auth: 'none' },
})
connections.remove('other', 'solo')
writeFileSync(join(out, 'extension-connections-after.json'), readFileSync(connectionsFile))
const sandboxFile = join(work, 'sandboxes.json')
const sandboxes = new SandboxStore(sandboxFile)
sandboxes.set('w1', {
  enabled: true,
  allowRead: ['~/notes'],
  allowWrite: ['~/builds'],
  domains: ['example.com'],
  deniedDomains: ['ads.example.com'],
  controls: { browser: 'unrestricted' },
  switches: { gitConfig: true },
  ports: 'deny',
})
sandboxes.set('w2', { enabled: false, allowRead: [], domains: [], controls: {} })
sandboxes.set('w3', { enabled: true, allowRead: [], domains: ['é.example.com'], controls: {} })
writeFileSync(join(out, 'sandboxes-before.json'), readFileSync(sandboxFile))
new SandboxStore(sandboxFile).remove('w3')
writeFileSync(join(out, 'sandboxes-after.json'), readFileSync(sandboxFile))
writeFileSync(join(out, 'pane-launcher.sh'), ostiaLauncherScript())
const claudeFixtureHooks = [
  { extId: 'acme.notes', event: 'Stop', command: 'check' },
  { extId: 'acme.notes', event: 'Notification', command: 'ping' },
  { extId: 'acme.lint', event: 'PreToolUse', command: 'lint' },
]
saveJson(join(out, 'claude-hook-settings.json'), claudeIntegration.claudeHookSettings())
saveJson(join(out, 'claude-hook-settings-extensions.json'), claudeIntegration.claudeHookSettings(claudeFixtureHooks))
writeFileSync(join(out, 'claude-wrapper.sh'), claudeIntegration.claudeWrapper())
saveJson(join(out, 'claude-plugin-manifest.json'), claudeIntegration.CLAUDE_PLUGIN_MANIFEST)
saveJson(join(out, 'claude-fold-manifest.json'), claudeIntegration.CLAUDE_FOLD_MANIFEST)
writeFileSync(join(out, 'agy-hooks.json'), agyIntegration.agyHooksJson())
writeFileSync(join(out, 'agy-plugin-digest.txt'), agyIntegration.agyPluginDigest())
writeFileSync(join(out, 'pane-banner-error.txt'), errorBanner('Sandbox unavailable'))
writeFileSync(
  join(out, 'pane-banner-integration-en.txt'),
  integrationNotLoadedNotice(en.native.paneBanner, 'ENOSPC'),
)
writeFileSync(
  join(out, 'pane-banner-integration-zh-hant.txt'),
  integrationNotLoadedNotice(zhHant.native.paneBanner, 'EACCES'),
)
writeFileSync(
  join(out, 'keep-shells-notice-en.txt'),
  keepShellsNotice(en.native.paneBanner, tmuxMissing(en.native.paneBanner)),
)
writeFileSync(
  join(out, 'keep-shells-notice-zh-hant.txt'),
  keepShellsNotice(zhHant.native.paneBanner, tmuxMissing(zhHant.native.paneBanner)),
)
writeFileSync(
  join(out, 'keep-shells-notice-multiline.txt'),
  keepShellsNotice(
    en.native.paneBanner,
    'tmux could not start its server: line one\n\x1b]0;x\x07two  \x7f three',
  ),
)

writeFileSync(
  join(out, 'sandbox-failure-banner-en.txt'),
  sandboxFailureBanner(en.native.paneBanner, 'cannot start', ['bwrap not found', 'socat is missing']),
)
writeFileSync(
  join(out, 'sandbox-failure-banner-zh-hant.txt'),
  sandboxFailureBanner(zhHant.native.paneBanner, 'cannot start', ['bwrap not found']),
)
writeFileSync(
  join(out, 'sandbox-failure-banner-bare.txt'),
  sandboxFailureBanner(en.native.paneBanner, 'cannot start', []),
)
writeFileSync(
  join(out, 'hidden-home-notice-en.txt'),
  hiddenHomeNotice(en.native.paneBanner, 'linux'),
)
writeFileSync(
  join(out, 'hidden-home-notice-zh-hant.txt'),
  hiddenHomeNotice(zhHant.native.paneBanner, 'linux'),
)
const sandboxTmp = new SandboxTmpDirs({ tmpRoot: '/t', pid: 4242 })
writeFileSync(
  join(out, 'sandbox-tmp-paths.json'),
  `${JSON.stringify(
    ['ws-1', 'é workspace'].map((id) => ({
      id,
      tmpDir: sandboxTmp.tmpDir(id),
      pluginsDir: sandboxTmp.pluginsDir(id),
      pluginsData: sandboxTmp.pluginsData(id),
      sshAgentSocket: sandboxTmp.sshAgentSocket(id),
    })),
    null,
    2,
  )}\n`,
)

const SNAPSHOT_BEFORE = {
  v: 1,
  savedAt: '2026-08-06T00:00:00.000Z',
  activeWorkspaceId: 'ghost',
  leftPanel: 'files',
  rightPanel: 'graphs',
  bounds: { x: 10.6, y: -20, width: 1280.4, height: 799.5 },
  detachedBounds: {
    w1: { x: 5, y: 5, width: 640, height: 480 },
    nope: { x: 5, y: 5, width: 640, height: 480 },
  },
  groups: [
    { id: 'g1', name: '  api é  ', color: 'purple', collapsed: true },
    { id: 'g1', name: 'duplicate' },
    { id: 'g2', name: 'no members' },
  ],
  workspaces: [
    {
      id: 'w1',
      name: 'terminal',
      customName: '  payments  ',
      description: '  PR #7  ',
      groupId: 'g1',
      kind: 'terminal',
      workDir: '/home/u/proj',
      projectDir: '/home/u/proj/sub',
      anchored: true,
      origin: { workspaceId: 'w0', index: 5000, groupId: 'g0', beside: { paneId: 'p0', zone: 'left' } },
      activePaneId: 'p9',
      root: {
        type: 'tabs',
        id: 't1',
        activeId: 'p9',
        children: [
          { type: 'pane', id: 'p1', title: 'zsh', kind: 'terminal', cwd: '/home/u/proj', defaultTitle: true, collapsed: true },
          {
            type: 'split',
            id: 'sp1',
            name: '  api  ',
            folded: true,
            direction: 'vertical',
            sizes: [2, 1, 1],
            children: [
              { type: 'pane', id: 'p2', title: 'a.ts', kind: 'editor', filePath: '/home/u/proj/a.ts', viewType: 'default' },
              { type: 'pane', id: 'p3', title: 'gone', kind: 'retired-kind' },
              {
                type: 'pane',
                id: 'p4',
                title: 'site',
                kind: 'browser',
                url: 'http://x/',
                browserProfile: 'shared',
                browserDevice: { preset: 'iphone-se', width: 900, height: 100, dpr: 7, zoom: 'actual' },
              },
            ],
          },
        ],
      },
    },
    {
      id: 'w2',
      name: '',
      kind: 'scratch',
      workDir: '/tmp/x',
      root: { type: 'pane', id: 'p5', title: 'zsh', kind: 'terminal' },
    },
    { id: 'w3', name: 'agents', pinned: true, groupId: 'g1', kind: 'bogus', workDir: '', root: { type: 'pane', id: 'p6', title: 'claude', kind: 'agent', agentSessionId: 'a1', titlePinned: true, resume: { agent: 'claude', id: 'abc-1', args: ['--model', 'opus'] }, agentRunning: true, keepAwake: true } },
  ],
  windows: [
    {
      id: 'd1',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      activeWorkspaceId: 'w7',
      leftPanel: 'files',
      rightPanel: 'keeper',
      workspaces: [
        { id: 'w7', name: 'detached', kind: 'terminal', workDir: '~', activePaneId: 'p8', root: { type: 'pane', id: 'p8', title: 'zsh', kind: 'terminal' } },
      ],
    },
    { id: 'bad id!', bounds: { x: 0, y: 0, width: 800, height: 600 }, workspaces: [] },
  ],
}
writeFileSync(join(out, 'workspace-snapshot-before.json'), `${JSON.stringify(SNAPSHOT_BEFORE, null, 2)}\n`)
saveJson(join(out, 'workspace-snapshot-after.json'), parseSnapshot(SNAPSHOT_BEFORE))

const SCROLLBACK_INPUT = {
  p1: 'plain line\nsecond é 日本語 😀 line\n',
  p2: '',
  p3: 'never saved',
  __proto__: 'x',
  p4: '\u001b[31mred\u001b[0m \u001b]133;C ls\r\n',
  constructor: 'y',
  prototype: 'z',
  p5: 'tail "quoted" back\\slash\ttab',
}
const scrollbackInput = JSON.parse(JSON.stringify(SCROLLBACK_INPUT))
Object.defineProperty(scrollbackInput, '__proto__', { value: 'x', enumerable: true, configurable: true, writable: true })
writeFileSync(join(out, 'scrollback-input.json'), JSON.stringify(scrollbackInput))
await saveJsonAsync(
  join(out, 'scrollback-saved.json'),
  scrollbackToSave(scrollbackInput, (paneId) => paneId === 'p3'),
)

const viewFile = join(work, 'git', 'view.json')
const view = new ViewStateStore(viewFile)
view.setChosen('/r/a', ['refs/heads/main', 'refs/remotes/origin/dev'])
view.setChosen('/r/b', ['refs/heads/é'])
view.setChosen('/r/c', ['refs/heads/x'])
writeFileSync(join(out, 'git-view-state-before.json'), readFileSync(viewFile))
view.setChosen('/r/b', null)
view.setChosen('/r/a', ['refs/heads/next'])
writeFileSync(join(out, 'git-view-state-after.json'), readFileSync(viewFile))
const viewsFile = join(work, 'views', 'views.json')
mkdirSync(join(work, 'views'), { recursive: true })
const views = new ViewStore(viewsFile)
views.set('agents', { enabled: true })
views.set('notes', { enabled: false })
views.set('ports', { enabled: true })
writeFileSync(join(out, 'views-before.json'), readFileSync(viewsFile))
views.set('agents', { enabled: false })
views.set('late', { enabled: true })
writeFileSync(join(out, 'views-after.json'), readFileSync(viewsFile))
writeFileSync(join(out, 'cli-usage-table.json'), `${JSON.stringify(USAGE_TABLE, null, 1)}\n`)

const BUS_FIXED_MS = Date.parse('2026-10-18T10:00:00.000Z')
const RealDate = Date
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length > 0 ? args : [BUS_FIXED_MS]))
  }

  static now() {
    return BUS_FIXED_MS
  }
}
const busFile = join(work, 'bus.json')
bus.setBusPath(busFile)
bus.enqueue({ id: 'm1', from: 'a', to: 'b', text: 'build é green\nsecond line' })
bus.enqueue({
  id: 'm2',
  from: 'a',
  to: 'c',
  text: 'do the task',
  task: true,
  wakes: true,
  route: 'remote:h',
  origin: 'remote:h',
})
bus.enqueue({ id: 'm3', from: 'a', to: 'd', text: 'read me' })
const handed = bus.leaseMail('d', 'read', () => true)
bus.ackMail('d', handed.lease)
bus.enqueue({ id: 'm4', from: 'a', to: 'e', text: 'lost' })
bus.failPaneMail('e')
bus.watchPane('boss', 'w1', ['done', 'command'])
bus.claimWake('ext-1', BUS_FIXED_MS, 3, 60_000)
await bus.flushBus()
writeFileSync(join(out, 'bus-before.json'), readFileSync(busFile))
bus.dismissFailed('e')
await bus.flushBus()
writeFileSync(join(out, 'bus-after.json'), readFileSync(busFile))
globalThis.Date = RealDate

const grantsBase = realpathSync(mkdtempSync(join(work, 'grants-')))
const grantsHome = join(grantsBase, 'home')
const grantsOutside = join(grantsBase, 'outside')
mkdirSync(grantsHome)
mkdirSync(grantsOutside)
writeFileSync(join(grantsOutside, 'app.log'), 'log')
writeFileSync(join(grantsOutside, 'other.log'), 'other')
const grantsFile = join(grantsBase, 'data', 'opened-files.json')
const grantsKept = new OpenFileGrants({ roots: () => [grantsHome], file: grantsFile })
const grantsHuman = { sandboxed: false, remember: true }
const withRootMarker = (bytes) => bytes.toString('utf8').replaceAll(grantsBase, '@ROOT@')
grantsKept.admit(join(grantsOutside, 'app.log'), grantsHuman)
writeFileSync(join(out, 'open-file-grants-before.json'), withRootMarker(readFileSync(grantsFile)))
grantsKept.admit(join(grantsOutside, 'other.log'), grantsHuman)
writeFileSync(join(out, 'open-file-grants-after.json'), withRootMarker(readFileSync(grantsFile)))

const chatBase = mkdtempSync(join(work, 'chat-'))
const CHAT_SESSION_INPUT = {
  id: 'chat-1',
  workspaceId: 'w1',
  title: '  Deploy   notes ',
  createdAt: 1700000000000,
  updatedAt: 1700000005000.5,
  model: 'fake · big',
  modelRef: { extId: 'assistant', provider: 'openai', model: 'gpt' },
  messageCount: 99,
  extra: 'dropped',
  messages: [
    {
      id: 'm1',
      role: 'user',
      parts: [{ type: 'text', text: 'list é 日本語 😀 "q" \\ \t' }, { type: 'bogus!' }],
      metadata: {
        createdAt: 1,
        model: ' m ',
        stopped: true,
        context: [{ kind: 'output', label: 'Output', text: 'ls' }],
      },
    },
    { id: 'm0', role: 'system', parts: [], extra: 1 },
    { id: 'bad', role: 'nobody', parts: [] },
    {
      id: 'm2',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'edit_file',
          toolCallId: 'e1',
          state: 'output-available',
          input: { path: '/home/u/p/a.ts' },
          output: { added: 1, removed: 1 },
        },
        { type: 'reasoning', text: 'thinking' },
        { type: 'text', text: 'done' },
      ],
    },
  ],
  edits: [
    {
      toolCallId: 'e1',
      path: '/home/u/p/a.ts',
      root: '/home/u/p',
      existed: true,
      outside: false,
      symlink: false,
      auto: true,
      state: 'applied',
      version: 'a'.repeat(64),
      seq: 2.7,
      decisions: ['accepted', 'rejected', 'bogus'],
      before: 'old',
      after: 'new',
    },
    { toolCallId: 'orphan', path: '/x', root: '/', state: 'applied', version: null, seq: 1 },
  ],
}
writeFileSync(join(out, 'chat-session-input.json'), JSON.stringify(CHAT_SESSION_INPUT))
createChatSessionStore({ dir: join(chatBase, 'sessions') }).save(CHAT_SESSION_INPUT)
writeFileSync(
  join(out, 'chat-session-saved.json'),
  readFileSync(join(chatBase, 'sessions', 'chat-1.json')),
)
const chatGrantsFile = join(chatBase, 'data', 'chat-tool-grants.json')
const chatGrants = new ChatToolGrants(chatGrantsFile)
chatGrants.add('open_file')
chatGrants.add('read-outside')
writeFileSync(join(out, 'chat-tool-grants-before.json'), readFileSync(chatGrantsFile))
chatGrants.add('mcp__fake__echo')
writeFileSync(join(out, 'chat-tool-grants-after.json'), readFileSync(chatGrantsFile))

const toHex = (bytes) => Buffer.from(bytes).toString('hex')
const SELECTION_META = {
  capture: { kind: 'image', imageWidth: 4, imageHeight: 3, region: null },
  rect: { x: 1, y: 2, width: 3, height: 4 },
  frame: { width: 800, height: 600 },
  text: 'h\u00e9llo \u597d \ud83d\ude00',
}
const SELECTION_PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const withPng = new Uint8Array(await encodeViewerSelection(SELECTION_META, SELECTION_PNG).arrayBuffer())
const withoutPng = new Uint8Array(await encodeViewerSelection(SELECTION_META, null).arrayBuffer())
writeFileSync(
  join(out, 'viewer-selection-body.json'),
  `${JSON.stringify({ meta: SELECTION_META, png: [...SELECTION_PNG], withPng: toHex(withPng), withoutPng: toHex(withoutPng) }, null, 2)}\n`,
)
const ESC = '\u001b'
const numbered = (from, count) =>
  Array.from({ length: count }, (_, i) => `out ${from + i}\r\n`).join('')
const SERIALIZE_CASES = [
  { name: 'default rows', cols: 80, rows: 24, input: 'one\r\ntwo\r\nthree\r\n', from: 0, to: 2 },
  { name: 'default last row', cols: 80, rows: 24, input: 'one\r\ntwo', from: 0, to: 1 },
  {
    name: 'styled last row left open',
    cols: 80,
    rows: 24,
    input: `plain\r\n${ESC}[31mred${ESC}[0m end${ESC}[44m tail`,
    from: 0,
    to: 1,
  },
  {
    name: 'styled last row closed',
    cols: 80,
    rows: 24,
    input: `plain\r\n${ESC}[1;32mbold green${ESC}[0m`,
    from: 0,
    to: 1,
  },
  {
    name: 'styled middle rows',
    cols: 80,
    rows: 24,
    input: `${ESC}[3mitalic${ESC}[0m\r\n${ESC}[38;2;10;20;30mrgb${ESC}[0m\r\nplain\r\n`,
    from: 0,
    to: 2,
  },
  { name: 'wide characters', cols: 80, rows: 24, input: '漢字 🙂 café\r\nx\r\n', from: 0, to: 1 },
  {
    name: 'coloured blank run',
    cols: 20,
    rows: 24,
    input: `plain   \r\n${ESC}[44mfill${ESC}[K${ESC}[0m\r\nlast`,
    from: 0,
    to: 2,
  },
  {
    name: 'soft wrap',
    cols: 20,
    rows: 24,
    input: `${ESC}[31mred${ESC}[0m ${'w'.repeat(50)}\r\nend\r\n`,
    from: 0,
    to: 3,
  },
  { name: 'blank rows between lines', cols: 80, rows: 24, input: 'a\r\n\r\n\r\nb\r\n', from: 0, to: 3 },
  {
    name: 'alternate screen',
    cols: 80,
    rows: 24,
    input: `main\r\n${ESC}[?1049hALT\r\nmore`,
    from: 0,
    to: 1,
  },
  {
    name: 'scrollback rows',
    cols: 10,
    rows: 5,
    input: numbered(0, 30),
    from: 0,
    to: 29,
  },
]
const serializeFixtures = SERIALIZE_CASES.map((c) => {
  const term = createHeadlessTerminal({ cols: c.cols, rows: c.rows, scrollback: 2000 })
  term.write(c.input)
  const lines = term.serialize({ from: c.from, to: c.to })
  term.dispose()
  return { ...c, lines }
})
writeFileSync(join(out, 'ghostty-serialize.json'), `${JSON.stringify(serializeFixtures, null, 2)}\n`)
const TELEMETRY_INSTALL_ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const TELEMETRY_FIXED_MS = Date.parse('2026-10-18T10:00:00.000Z')
const telemetryFile = join(work, 'telemetry.json')
writeFileSync(telemetryFile, JSON.stringify({ installId: TELEMETRY_INSTALL_ID }))
let telemetryEvents = 0
const telemetry = createTelemetry({
  file: telemetryFile,
  endpoint: null,
  context: () => ({
    app_version: '1.0.0',
    electron_version: '33',
    os_name: 'linux',
    os_version: '6',
    arch: 'x64',
    locale: 'en',
    channel: 'source',
  }),
  settings: () => ({ errors: true, usage: false, features: false, terminal: false, extensions: false, agents: false }),
  session: () => ({ windows: '1', workspaces: '1', restore: 'ok', inEffect: {}, installedExtensions: [], enabledExtensions: [] }),
  now: () => TELEMETRY_FIXED_MS,
  newId: () => `e${++telemetryEvents}`,
})
telemetry.error({
  source: 'main-exception',
  name: 'TypeError',
  message: 'boom in /home/ann/x.js',
  stack: 'TypeError: boom\n    at f (/home/ann/x.js:1:2)',
})
writeFileSync(join(out, 'telemetry-before.json'), readFileSync(telemetryFile))
telemetry.consented()
writeFileSync(join(out, 'telemetry-after.json'), readFileSync(telemetryFile))
await telemetry.shutdown()
rmSync(work, { recursive: true, force: true })

saveJson(join(out, 'install-replace-pending.json'), {
  appDir: '/home/u/.local/share/ostia/app',
  version: '0.6.0',
})
saveJson(join(out, 'install-replace-swept.json'), null)
saveJson(join(out, 'dict-en.json'), en)
saveJson(join(out, 'dict-zh-hant.json'), zhHant)
saveJson(join(contractData, 'dict_en.json'), en)
saveJson(join(contractData, 'dict_zh_hant.json'), zhHant)
saveJson(join(out, 'dict-en-merged.json'), mergeCatalog({}))
saveJson(join(out, 'dict-zh-hant-merged.json'), mergeCatalog(zhHant))
saveJson(join(out, 'release-check-dismissed.json'), { dismissedVersion: '0.3.0' })

const figDir = mkdtempSync(join(tmpdir(), 'rust-fig-specs-'))
const { writeFigSpecs } = await import('./completionSpecs.mjs')
await writeFigSpecs(figDir)
mkdirSync(join(out, 'completion-specs'), { recursive: true })
for (const name of ['git.json', 'tar.json']) {
  writeFileSync(join(out, 'completion-specs', name), readFileSync(join(figDir, name)))
}
rmSync(figDir, { recursive: true, force: true })

const gatewayDir = mkdtempSync(join(tmpdir(), 'rust-gateway-'))
process.env.XDG_DATA_HOME = gatewayDir
const GATEWAY_NOW = 1700000000000
function atFixedTime(run) {
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(GATEWAY_NOW)
      else super(...args)
    }
    static now() {
      return GATEWAY_NOW
    }
  }
  try {
    run()
  } finally {
    globalThis.Date = RealDate
  }
}
const devicesFile = join(gatewayDir, 'ostia', 'gateway-devices.json')
const pushOn = (platform) => ({ enabled: true, handle: 'h'.repeat(26), platform })
const named = {}
atFixedTime(() => {
  const add = (name, extra = {}) => {
    named[name] = gatewayDevices.registerDevice({ name, pubkey: `pk-${name}`, ...extra }).deviceId
    return named[name]
  }
  gatewayDevices.touchDevice(add('Desk', { installId: 'd'.repeat(20) }))
  gatewayDevices.setDevicePush(add('Pixel'), pushOn('fcm'))
  const tab = add('Tab')
  gatewayDevices.setDevicePush(tab, pushOn('apns'))
  gatewayDevices.touchDevice(tab)
  gatewayDevices.setDeviceCap(add('Old'), 'input', true)
  add('Plain')
})
const stored = JSON.parse(readFileSync(devicesFile, 'utf8'))
stored[named.Old].caps = ['input', 'board.read', 'read', 'read', 'notify']
stored[named.Plain].push = { enabled: true, handle: 'bad handle!', platform: 'fcm' }
writeFileSync(devicesFile, JSON.stringify(stored, null, 2))
writeFileSync(join(out, 'gateway-devices-before.json'), readFileSync(devicesFile))
atFixedTime(() => {
  gatewayDevices.setDevicePush(named.Desk, pushOn('fcm'))
  gatewayDevices.touchDevice(named.Pixel)
  gatewayDevices.setDevicePush(named.Tab, { enabled: false })
  gatewayDevices.setDevicePush(named.Tab, pushOn('apns'))
  gatewayDevices.setDeviceName(named.Plain, '  Renamed  ')
  gatewayDevices.setDeviceCap(named.Old, 'command', true)
})
writeFileSync(join(out, 'gateway-devices-after.json'), readFileSync(devicesFile))

const digestOf = (text) => createHash('sha256').update(text).digest()
const checkRows = Array.from({ length: 300 }, (_, i) => {
  const fingerprint = i % 7 === 0 ? `sha256/é${i}日本` : `sha256/${digestOf(`fp${i}`).toString('base64')}`
  const pubkey = i % 5 === 0 ? `ключ${i}` : digestOf(`pk${i}`).toString('base64')
  const phone = digestOf(`phone${i}`)
  const desktop = digestOf(`desktop${i}`)
  return {
    fingerprint,
    pubkey,
    phone: phone.toString('hex'),
    desktop: desktop.toString('hex'),
    code: checkCode(fingerprint, pubkey, phone, desktop),
  }
})
writeFileSync(join(out, 'gateway-pair-check.json'), `${JSON.stringify(checkRows)}\n`)

atFixedTime(() => {
  gatewayPairing.auditPairAttempt('127.0.0.1', 'ok')
  gatewayPairing.auditPairAttempt('::ffff:127.0.0.1', 'invalid-code')
  gatewayPairing.auditPairAttempt('::1', 'bad-request')
  gatewayPairing.auditPairAttempt('203.0.113.9', 'rate-limited')
  gatewayPairing.auditPairAttempt('203.0.113.9', 'ok', 'relay')
  gatewayPairing.auditPairAttempt('127.0.0.1', 'ok', 'relay')
  gatewayPairing.auditPairAttempt('127.evil', 'ok')
})
writeFileSync(
  join(out, 'gateway-pair-audit.jsonl'),
  readFileSync(gatewayPairing.pairAuditLogPath()),
)
rmSync(gatewayDir, { recursive: true, force: true })

const longRun = (word, count) => Array.from({ length: count }, () => word).join(' ')
const LINE_CASES = [
  ['', ''],
  ['', 'a\n'],
  ['a\n', ''],
  ['a\nb\nc\n', 'a\nb\nc\n'],
  ['a\nb\nc\n', 'a\nX\nb\nc\n'],
  ['a\nb\nc\n', 'a\nc\n'],
  ['a\nb\nc\n', 'a\nB\nc\n'],
  ['a\nb\na\n', 'b\na\nb\n'],
  ['a\nb', 'a\nb\n'],
  ['a\r\nb\r\n', 'a\nb\n'],
  ['one\n\n\ntwo\n', 'one\n\ntwo\n\nthree\n'],
  ['é\n日本語\n😀\n', 'é\n日本\n😀 x\n'],
  ['x\ny\nz\n', 'p\nq\nr\n'],
  ['a\nb\nc\nd\ne\nf\n', 'f\ne\nd\nc\nb\na\n'],
  [
    Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n'),
    Array.from({ length: 400 }, (_, i) => (i === 200 ? 'changed' : `line ${i}`)).join('\n'),
  ],
  [
    Array.from({ length: 120 }, (_, i) => `l${i % 7}`).join('\n'),
    Array.from({ length: 120 }, (_, i) => `l${(i * 3) % 7}`).join('\n'),
  ],
]
const WORD_CASES = [
  ['', '', undefined],
  ['', 'hello', undefined],
  ['hello', '', undefined],
  ['a b c', 'a b c', undefined],
  ['a b c', 'a X b c', undefined],
  ['a b c', 'a c', undefined],
  ['a b c', 'a B c', undefined],
  ['a b a', 'b a b', undefined],
  ['the quick  brown fox', 'the quick brown  fox', undefined],
  ['a\tb\nc', 'a b\nc', undefined],
  ['foo-bar baz_qux', 'foo bar baz-qux', undefined],
  ['é日本語 😀 x', 'é日本 😀 y x', undefined],
  ['naïve café', 'naive cafe', undefined],
  ['a b', 'c d', undefined],
  ['  lead', 'lead  ', undefined],
  ['x', 'y', 0],
  ['a b c d e f g', 'g f e d c b a', 3],
  [longRun('word', 300), `${longRun('word', 150)} extra ${longRun('word', 150)}`, undefined],
  [longRun('ab', 200), longRun('ba', 200), 600],
  [longRun('alpha beta', 80), longRun('beta alpha', 80), 2],
]
const diffRow = (mode, before, after, maxEdits, changes) => ({
  mode,
  before,
  after,
  maxEdits: maxEdits ?? null,
  changes: changes
    ? changes.map(({ added, removed, value }) => ({ added: !!added, removed: !!removed, value }))
    : null,
})
writeFileSync(
  join(out, 'text-diff.json'),
  `${JSON.stringify([
    ...LINE_CASES.map(([before, after]) => diffRow('lines', before, after, null, diffLines(before, after))),
    ...WORD_CASES.map(([before, after, maxEdits]) =>
      diffRow(
        'words',
        before,
        after,
        maxEdits,
        diffWordsWithSpace(before, after, maxEdits === undefined ? {} : { maxEditLength: maxEdits }),
      ),
    ),
  ])}\n`,
)

writeFileSync(join(out, 'color-schemes.json'), `${JSON.stringify(BUILTIN_COLOR_SCHEMES, null, 1)}\n`)

const FONT_FAMILIES = [
  'MesloLGS NF',
  'Inter Variable',
  'Evil"; } * {',
  '  ',
  '',
  'a\\b<c>d{e}f;g',
  '  Fira Code  ',
  '日本語 Mono',
  'Tab\tName',
  '\u00a0Nbsp\u00a0',
  '\ufeffBom',
]
const FONT_SETTINGS = [
  { ui: { family: 'Inter Variable', size: 14, weight: 500 }, editor: { family: 'Bitstream Vera Sans Mono', size: 14, weight: 500 } },
  { ui: { family: 'Geist Variable', size: 14, weight: 400 }, editor: { family: 'Geist Mono Variable', size: 13, weight: 400 } },
  { ui: { family: '', size: 12.5, weight: 700 }, editor: { family: 'x"y', size: 9, weight: 100 } },
]
writeFileSync(
  join(out, 'ui-fonts.json'),
  `${JSON.stringify(
    {
      uiFallback: uiFonts.UI_FONT_FALLBACK,
      codeFallback: { mac: uiFonts.codeFontFallback(true), other: uiFonts.codeFontFallback(false) },
      terminalFallback: {
        mac: uiFonts.terminalFontFallback(true),
        other: uiFonts.terminalFontFallback(false),
      },
      stacks: FONT_FAMILIES.map((family) => ({
        family,
        ui: uiFonts.uiFontStack(family),
        code: uiFonts.codeFontStack(family),
        terminal: uiFonts.terminalFontStack(family),
      })),
      variables: FONT_SETTINGS.map((fonts) => ({ fonts, variables: uiFonts.uiFontVariables(fonts) })),
    },
    null,
    1,
  )}\n`,
)

const SEARCH_ENGINE_NAMES = browserEditorSettings.SEARCH_ENGINES
const SEARCH_QUERIES = ['a b&c', 'x y', '', '日本語 🙂', "it's (ok)!*~-._", '100% {query}', 'a/b?c=d#e']
const CUSTOM_TEMPLATES = [
  '',
  'https://s.test/?term={query}',
  'ftp://s.test/{query}',
  '{query}{query}',
  'http://127.0.0.1:8080/{query}',
  'https://example.com/s?q=',
  'javascript:alert({query})',
  'file:///tmp/{query}',
  'https://[bad/{query}',
  'HTTPS://Example.com/{query}',
  'https://u:p@h.test/{query}',
  'https://h.test/{query}/{query}',
  ' https://h.test/{query}',
  'https://h.test/ {query}',
  'mailto:{query}',
  'data:text/plain,{query}',
  'http:/h.test/{query}',
  'https:h.test/{query}',
]
const searchRows = []
for (const engine of SEARCH_ENGINE_NAMES) {
  for (const customSearchUrl of CUSTOM_TEMPLATES) {
    for (const query of SEARCH_QUERIES) {
      const settings = { searchEngine: engine, customSearchUrl, defaultZoom: 100, attachCaptureImage: true }
      let url
      try {
        url = browserEditorSettings.searchUrl(settings, query)
      } catch {
        url = null
      }
      searchRows.push({ searchEngine: engine, customSearchUrl, query, url })
    }
  }
}
const ZOOM_INPUTS = [10, 49.5, 50, 50.5, 99.5, 100.5, 125.4, 125.5, 299.5, 300, 300.4, 999, -5, -0.4, 0, 1e308, 2.5, 3.5]
const PARSE_BROWSER_INPUTS = [
  null,
  [],
  'x',
  1,
  {},
  { searchEngine: 'kagi', defaultZoom: 500, attachCaptureImage: false },
  { searchEngine: 'nope', defaultZoom: 'big', attachCaptureImage: 1 },
  { searchEngine: 'custom', customSearchUrl: 'https://s.test/{query}', defaultZoom: 49.5 },
  { customSearchUrl: 5, defaultZoom: 1e308 },
  { customSearchUrl: '', defaultZoom: -3, searchEngine: ['google'] },
  { searchEngine: 'DuckDuckGo', defaultZoom: 150.5 },
  { defaultZoom: null, attachCaptureImage: null },
  { extra: true, searchEngine: 'bing' },
]
const PARSE_EDITOR_INPUTS = [
  undefined,
  null,
  [],
  'x',
  {},
  { tabSize: 3, wordWrap: 'bounded', autoSave: 'always' },
  {
    wordWrap: 'on',
    lineNumbers: 'relative',
    tabSize: 8,
    insertSpaces: false,
    autoSave: 'afterDelay',
    formatOnSave: true,
    openFilesIn: 'split',
    theme: 'rose-pine',
    diffLayout: 'inline',
    diffIgnoreWhitespace: true,
  },
  { tabSize: '4', lineNumbers: 'RELATIVE', insertSpaces: 'no', formatOnSave: 1, diffIgnoreWhitespace: 'yes' },
  { tabSize: 4.0, theme: '  ', diffLayout: 'sideBySide' },
  { theme: 'x'.repeat(80) },
  { theme: 'x'.repeat(81) },
  { theme: ' padded ' },
  { theme: null, openFilesIn: ['tab'] },
  { autoSave: 'onFocusChange', lineNumbers: 'off', wordWrap: 'off', tabSize: 2 },
]
writeFileSync(
  join(out, 'browser-editor-settings.json'),
  `${JSON.stringify(
    {
      browserDefaults: browserEditorSettings.DEFAULT_BROWSER_SETTINGS,
      editorDefaults: browserEditorSettings.DEFAULT_EDITOR_SETTINGS,
      searchUrls: searchRows,
      validTemplates: CUSTOM_TEMPLATES.map((template) => ({
        template,
        valid: browserEditorSettings.isValidSearchTemplate(template),
      })),
      zoom: ZOOM_INPUTS.map((input) => ({ input, output: browserEditorSettings.clampZoom(input) })),
      zoomNonFinite: ['NaN', 'Infinity', '-Infinity'].map((input) => ({
        input,
        output: browserEditorSettings.clampZoom(Number(input)),
      })),
      browser: PARSE_BROWSER_INPUTS.map((input) => ({
        input,
        output: browserEditorSettings.parseBrowserSettings(input),
      })),
      editor: PARSE_EDITOR_INPUTS.map((input) => ({
        input: input === undefined ? null : input,
        output: browserEditorSettings.parseEditorSettings(input),
      })),
    },
    null,
    1,
  )}\n`,
)

writeFileSync(join(out, 'agent-schema.json'), `${JSON.stringify(agentSchema, null, 1)}\n`)
