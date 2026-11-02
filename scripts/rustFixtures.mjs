import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const root = process.cwd()
const out = join(root, 'test/fixtures/rust')
const work = mkdtempSync(join(tmpdir(), 'rust-fixtures-'))

const ENTRY = `
export { ParkedStore } from './src/main/park/parkedStore'
export { SandboxStore } from './src/main/sandbox/store'
export { ViewStateStore } from './src/main/git/viewState'
export { saveJson, saveJsonAsync } from './src/main/platform/jsonStore'
export { ostiaLauncherScript } from './src/main/terminal/paneLauncher'
export { errorBanner, integrationNotLoadedNotice } from './src/main/terminal/paneBanner'
export { en, zhHant, mergeCatalog } from './src/shared/app/dict'
export { keepShellsNotice, tmuxMissing } from './src/main/tmux/keepShellsBanner'
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
export * as claudeIntegration from './src/main/terminal/claudeIntegration'
export * as agyIntegration from './src/main/terminal/agyIntegration'
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
  SandboxStore,
  saveJson,
  saveJsonAsync,
  ostiaLauncherScript,
  errorBanner,
  integrationNotLoadedNotice,
  keepShellsNotice,
  tmuxMissing,
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
  claudeIntegration,
  agyIntegration,
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
