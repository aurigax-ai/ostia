import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import {
  PROMPT,
  openWorkspace,
  quitApp,
  runInTerminal,
  stubExternalOpener,
  waitForExit,
} from './helpers'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

test.skip(process.platform !== 'darwin', 'app bundles, hdiutil and codesign are macOS only')

const BETA = '999.0.0-rc.1'
const STABLE = '998.0.0'
const INSTALLED = '1.0.0'
const BUNDLE_ID = 'ai.aurigax.ostia'
const DMG = `ostia-${BETA}-arm64.dmg`
const DOWNLOAD = `/aurigax-ai/ostia/releases/download/v${BETA}`
const BREW_COMMAND = 'brew upgrade --cask ostia'

function plist(version: string, identifier: string): string {
  const entries: Record<string, string> = {
    CFBundleExecutable: 'Ostia',
    CFBundleIdentifier: identifier,
    CFBundleName: 'Ostia',
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
  }
  const body = Object.entries(entries)
    .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>\n`
}

function asarArchive(files: Record<string, string>): Buffer {
  const header: { files: Record<string, { size: number; offset: string }> } = { files: {} }
  const bodies: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content)
    header.files[name] = { size: body.length, offset: String(offset) }
    offset += body.length
    bodies.push(body)
  }
  const json = Buffer.from(JSON.stringify(header))
  const padded = Math.ceil(json.length / 4) * 4
  const headerPickle = Buffer.alloc(8 + padded)
  headerPickle.writeUInt32LE(4 + padded, 0)
  headerPickle.writeUInt32LE(json.length, 4)
  json.copy(headerPickle, 8)
  const sizePickle = Buffer.alloc(8)
  sizePickle.writeUInt32LE(4, 0)
  sizePickle.writeUInt32LE(headerPickle.length, 4)
  return Buffer.concat([sizePickle, headerPickle, ...bodies])
}

function withAsar(resources: string): void {
  mkdirSync(resources, { recursive: true })
  writeFileSync(
    join(resources, 'app.asar'),
    asarArchive({ 'package.json': '{"name":"ostia"}', 'index.js': 'module.exports = 1\n' }),
  )
}

function appBundle(
  bundle: string,
  version: string,
  opts: { identifier?: string; buildVersion?: string } = {},
): string {
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(join(bundle, 'Contents', 'Resources'), { recursive: true })
  copyFileSync('/usr/bin/true', join(bundle, 'Contents', 'MacOS', 'Ostia'))
  withAsar(join(bundle, 'Contents', 'Resources'))
  chmodSync(join(bundle, 'Contents', 'MacOS', 'Ostia'), 0o755)
  writeFileSync(
    join(bundle, 'Contents', 'Info.plist'),
    plist(version, opts.identifier ?? BUNDLE_ID),
  )
  writeFileSync(
    join(bundle, 'Contents', 'Resources', 'build-info.json'),
    JSON.stringify({ version: opts.buildVersion ?? version, builtAt: '2026-10-13T00:00:00Z' }),
  )
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle])
  return bundle
}

function diskImage(root: string, app: { identifier?: string; buildVersion?: string }): Buffer {
  const stage = join(root, 'image')
  appBundle(join(stage, 'Ostia.app'), BETA, app)
  const file = join(root, DMG)
  execFileSync('hdiutil', [
    'create',
    '-quiet',
    '-volname',
    'Ostia',
    '-srcfolder',
    stage,
    '-format',
    'UDZO',
    '-ov',
    file,
  ])
  return readFileSync(file)
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

interface Layout {
  root: string
  bundle: string
  files: Record<string, Buffer>
  digest: string
}

function layout(
  opts: {
    identifier?: string
    buildVersion?: string
    sums?: (dmg: Buffer) => string
    bundleDir?: string
  } = {},
): Layout {
  const root = mkdtempSync(join(tmpdir(), 'ostia-e2e-mac-update-'))
  const bundle = appBundle(join(root, opts.bundleDir ?? 'Applications', 'Ostia.app'), INSTALLED)
  const dmg = diskImage(root, opts)
  return {
    root,
    bundle,
    digest: sha256(dmg),
    files: {
      [`${DOWNLOAD}/${DMG}`]: dmg,
      [`${DOWNLOAD}/SHA256SUMS`]: Buffer.from(`${(opts.sums ?? sha256)(dmg)}  ${DMG}\n`),
    },
  }
}

interface FakeGitHub {
  url: string
  downloads: string[]
  close: () => Promise<void>
}

function releaseEntry(version: string, digest: string | null) {
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/aurigax-ai/ostia/releases/tag/v${version}`,
    draft: false,
    prerelease: version.includes('-'),
    assets: digest ? [{ name: `ostia-${version}-arm64.dmg`, digest: `sha256:${digest}` }] : [],
  }
}

async function startFakeGitHub(
  files: Record<string, Buffer>,
  digest: string,
  stable = '0.0.1',
): Promise<FakeGitHub> {
  const downloads: string[] = []
  const server: Server = createServer((req, res) => {
    const file = files[req.url ?? '']
    if (file) {
      downloads.push(req.url ?? '')
      res.writeHead(200, { 'content-length': file.byteLength })
      res.end(file)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    const latest = releaseEntry(stable, null)
    const list = [releaseEntry(BETA, digest), releaseEntry('999.0.1-main.3', digest), latest]
    res.end(JSON.stringify(req.url?.includes('/releases?') ? list : latest))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    downloads,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

function macEnv(github: FakeGitHub, bundle: string, method = 'dmg'): Record<string, string> {
  return {
    OSTIA_RELEASE_API_URL: github.url,
    OSTIA_RELEASE_DOWNLOAD_BASE_URL: github.url,
    OSTIA_INSTALL_METHOD: method,
    OSTIA_INSTALL_APP_DIR: bundle,
    OSTIA_UPDATE_SIGNATURE: 'adhoc',
  }
}

async function launch(
  dataHome: string,
  env: Record<string, string>,
): Promise<{ app: ElectronApplication; win: Page }> {
  const options = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...options, env: { ...options.env, ...env } })
  const win = await app.firstWindow()
  await stubExternalOpener(app)
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}

async function openAbout(win: Page) {
  await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
  const settings = win.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'About' }).click()
  return settings
}

const versionIn = (bundle: string): string =>
  JSON.parse(readFileSync(join(bundle, 'Contents', 'Resources', 'build-info.json'), 'utf8')).version

const stagedOf = (bundle: string): string => join(bundle, '..', '.Ostia.app.new')

function mainLog(dataHome: string): string {
  const file = join(dataHome, 'userData', 'logs', 'main.log')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

async function downloadAndStage(win: Page): Promise<void> {
  const notice = win.locator('.update-notice')
  await notice.getByRole('button', { name: 'Download and install' }).click({ timeout: 30_000 })
  await expect(notice.getByRole('button', { name: 'Restart Ostia' })).toBeVisible({
    timeout: 60_000,
  })
}

let traces = 0

async function stopTraceBeforeExit(app: ElectronApplication): Promise<void> {
  traces += 1
  await app
    .context()
    .tracing.stop({ path: test.info().outputPath(`app-trace-before-exit-${traces}.zip`) })
    .catch(() => {})
}

async function restartFromNotice(
  app: ElectronApplication,
  win: Page,
  dataHome: string,
): Promise<void> {
  await app.evaluate(({ app: electronApp }) => {
    electronApp.relaunch = () => undefined
  })
  await stopTraceBeforeExit(app)
  const closed = waitForExit(app)
  await win.locator('.update-notice').getByRole('button', { name: 'Restart Ostia' }).click()
  const quit = win.getByRole('dialog').getByRole('button', { name: 'Quit' })
  const asked = await Promise.race([
    closed.then(() => false),
    quit
      .waitFor({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false),
  ])
  if (asked) await quit.click().catch(() => {})
  await closed
  expect(app.process().exitCode).toBe(0)
  expect(mainLog(dataHome)).toMatch(/quit-stage stage=teardown-done after=update-swap/)
  expect(mainLog(dataHome)).toMatch(/update-swap version=\S+ result=swapped/)
}

function fakeAgentBin(dataHome: string, script: string[]): string {
  const bin = join(dataHome, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'claude'), [...script, ''].join('\n'))
  chmodSync(join(bin, 'claude'), 0o755)
  return bin
}

const RESUME_TOKEN = 'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" resume-token claude'

function savedPanes(dataHome: string): Record<string, unknown>[] {
  const file = join(dataHome, 'ostia', 'workspaces.json')
  if (!existsSync(file)) return []
  const out: Record<string, unknown>[] = []
  const walk = (node: Record<string, unknown> | undefined): void => {
    if (!node) return
    if (node.type === 'pane') out.push(node)
    for (const child of (node.children as Record<string, unknown>[] | undefined) ?? []) walk(child)
  }
  for (const w of JSON.parse(readFileSync(file, 'utf8')).workspaces) walk(w.root)
  return out
}

test('a dmg install with Receive beta updates on downloads, verifies and stages the rc, then swaps it in on restart', async () => {
  test.setTimeout(180_000)
  const l = layout()
  const github = await startFakeGitHub(l.files, l.digest)
  const dataHome = freshDataHome()
  const { app, win } = await launch(dataHome, macEnv(github, l.bundle))
  let closed = false
  try {
    const settings = await openAbout(win)
    await expect(settings.getByText('Installed from the dmg')).toBeVisible()
    await expect(settings.getByRole('combobox', { name: 'Update channel' })).toHaveCount(0)
    const beta = settings.getByRole('switch', { name: 'Receive beta updates' })
    await expect(beta).not.toBeChecked()
    await beta.click()
    await expect(beta).toBeChecked()
    await expect(settings.getByText(/brew upgrade --cask ostia/)).toHaveCount(0)

    await downloadAndStage(win)
    expect(github.downloads).toEqual([`${DOWNLOAD}/SHA256SUMS`, `${DOWNLOAD}/${DMG}`])
    expect(versionIn(l.bundle)).toBe(INSTALLED)
    expect(versionIn(stagedOf(l.bundle))).toBe(BETA)

    await restartFromNotice(app, win, dataHome)
    closed = true
    expect(versionIn(l.bundle)).toBe(BETA)
    expect(versionIn(`${l.bundle}.old`)).toBe(INSTALLED)
    expect(existsSync(stagedOf(l.bundle))).toBe(false)
    execFileSync('codesign', ['--verify', '--deep', '--strict', l.bundle])
    expect(mainLog(dataHome).indexOf('teardown-ptys')).toBeLessThan(
      mainLog(dataHome).indexOf('update-swap'),
    )
  } finally {
    if (!closed) await quitApp(app)
    await github.close()
  }
})

const refusals = [
  {
    name: 'another bundle identifier',
    opts: { identifier: 'com.example.ostia' },
    message: 'The downloaded app isn’t signed as Ostia. Nothing was changed.',
  },
  {
    name: 'a dmg that does not match its checksum',
    opts: { sums: () => 'f'.repeat(64) },
    message: 'The downloaded archive didn’t match its checksum. Nothing was changed.',
  },
  {
    name: 'another version inside the dmg',
    opts: { buildVersion: '999.0.0-rc.0' },
    message: 'The archive holds a different version. Nothing was changed.',
  },
]

for (const refusal of refusals) {
  test(`${refusal.name} leaves the installed app as it was and says why`, async () => {
    test.setTimeout(120_000)
    const l = layout(refusal.opts)
    const github = await startFakeGitHub(l.files, l.digest)
    const dataHome = freshDataHome()
    seedSettings(dataHome, {
      ...DOM_RENDERER_SETTINGS,
      behavior: { gpuAcceleration: false, updateChannel: 'beta' },
    })
    const { app, win } = await launch(dataHome, macEnv(github, l.bundle))
    try {
      await win
        .locator('.update-notice')
        .getByRole('button', { name: 'Download and install' })
        .click({ timeout: 30_000 })
      const settings = await openAbout(win)
      await expect(settings.getByText(refusal.message)).toBeVisible({ timeout: 60_000 })
      expect(versionIn(l.bundle)).toBe(INSTALLED)
      expect(readdirSync(join(l.bundle, '..'))).toEqual(['Ostia.app'])
      await expect(settings.getByRole('button', { name: 'Download and install' })).toBeEnabled()
    } finally {
      await quitApp(app)
      await github.close()
    }
  })
}

test('an app running translocated is told to move to Applications and downloads nothing', async () => {
  const l = layout({ bundleDir: join('AppTranslocation', 'A1B2', 'd') })
  const github = await startFakeGitHub(l.files, l.digest)
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    behavior: { gpuAcceleration: false, updateChannel: 'beta' },
  })
  const { app, win } = await launch(dataHome, macEnv(github, l.bundle))
  try {
    const settings = await openAbout(win)
    await expect(
      settings.getByText(
        /^macOS is running Ostia from a temporary copy\. Move Ostia to Applications/,
      ),
    ).toBeVisible({ timeout: 30_000 })
    await expect(settings.getByRole('button', { name: 'Download and install' })).toHaveCount(0)
    await expect(settings.getByRole('button', { name: 'View release' })).toBeVisible()
    expect(github.downloads).toEqual([])
  } finally {
    await quitApp(app)
    await github.close()
  }
})

function fakeBrew(dataHome: string): { bin: string; log: string } {
  const bin = join(dataHome, 'brew-bin')
  const log = join(dataHome, 'brew.log')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'brew'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\necho "fake brew ran: $*"\n`,
  )
  chmodSync(join(bin, 'brew'), 0o755)
  return { bin, log }
}

test('a brew install on Stable still updates through brew upgrade --cask ostia in a terminal', async () => {
  test.setTimeout(120_000)
  const l = layout()
  const github = await startFakeGitHub(l.files, l.digest, STABLE)
  const dataHome = freshDataHome()
  const brew = fakeBrew(dataHome)
  const { app, win } = await launch(dataHome, {
    ...macEnv(github, l.bundle, 'brew'),
    PATH: `${brew.bin}:${process.env.PATH}`,
  })
  try {
    await openWorkspace(win)
    const notice = win.locator('.update-notice')
    await notice.getByRole('button', { name: 'Update with Homebrew' }).click({ timeout: 30_000 })
    const dialog = win.getByRole('dialog', { name: 'Update Ostia with Homebrew' })
    await expect(dialog).toContainText(BREW_COMMAND)
    await dialog.getByRole('button', { name: 'Open terminal' }).click()
    const updater = win.locator('.xterm-rows').filter({ hasText: 'fake brew ran' })
    await expect(updater).toContainText('fake brew ran: upgrade --cask ostia', { timeout: 20_000 })
    await expect(updater).toContainText(PROMPT)
    expect(github.downloads).toEqual([])
    expect(versionIn(l.bundle)).toBe(INSTALLED)
  } finally {
    await quitApp(app)
    await github.close()
  }
})

test('a brew install with Receive beta updates on installs the rc in the app, warns about brew and never runs brew', async () => {
  test.setTimeout(120_000)
  const l = layout()
  const github = await startFakeGitHub(l.files, l.digest, STABLE)
  const dataHome = freshDataHome()
  const brew = fakeBrew(dataHome)
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    behavior: { gpuAcceleration: false, updateChannel: 'beta' },
  })
  const { app, win } = await launch(dataHome, {
    ...macEnv(github, l.bundle, 'brew'),
    PATH: `${brew.bin}:${process.env.PATH}`,
  })
  try {
    await downloadAndStage(win)
    await expect(win.locator('.update-notice').getByText('Update with Homebrew')).toHaveCount(0)
    expect(versionIn(stagedOf(l.bundle))).toBe(BETA)
    const settings = await openAbout(win)
    await expect(settings.getByText('Installed with Homebrew')).toBeVisible()
    await expect(settings.getByRole('switch', { name: 'Receive beta updates' })).toBeChecked()
    await expect(
      settings.getByText(
        'Running brew upgrade --cask ostia yourself installs the Homebrew release again, which can be older than this beta.',
      ),
    ).toBeVisible()
    expect(existsSync(brew.log)).toBe(false)
  } finally {
    await quitApp(app)
    await github.close()
  }
})

test('after an update restart, an agent resumes with --resume and the same session id', async () => {
  test.setTimeout(180_000)
  const l = layout()
  const github = await startFakeGitHub(l.files, l.digest)
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    behavior: { gpuAcceleration: false, updateChannel: 'beta' },
    agents: { autoResume: true },
  })
  const bin = fakeAgentBin(dataHome, [
    '#!/bin/sh',
    'case "$*" in',
    '  *--resume*) echo "fake-agent-resumed $*" ;;',
    `  *) for arg; do last=$arg; done; ${RESUME_TOKEN} "$last" >/dev/null 2>&1; echo fake-agent-ready ;;`,
    'esac',
    'exec cat',
  ])
  const env = { ...macEnv(github, l.bundle), PATH: `${bin}:${process.env.PATH}` }
  const first = await launch(dataHome, env)
  let closed = false
  try {
    await openWorkspace(first.win)
    await runInTerminal(first.win, 'claude e2e-update-session-1')
    await expect(first.win.locator('.xterm-rows').first()).toContainText('fake-agent-ready', {
      timeout: 15_000,
    })
    await expect
      .poll(() => savedPanes(dataHome).filter((p) => p.resume && p.agentRunning === true).length, {
        timeout: 15_000,
      })
      .toBe(1)
    await downloadAndStage(first.win)
    await restartFromNotice(first.app, first.win, dataHome)
    closed = true
  } finally {
    if (!closed) await quitApp(first.app)
  }
  expect(versionIn(l.bundle)).toBe(BETA)

  const second = await launch(dataHome, env)
  try {
    await expect(
      second.win
        .locator('.xterm-rows')
        .filter({ hasText: /fake-agent-resumed .*--resume e2e-update-session-1\b/ }),
    ).toHaveCount(1, { timeout: 30_000 })
  } finally {
    await stopTraceBeforeExit(second.app)
    second.app.process().kill('SIGKILL')
    await github.close()
  }
})

test('after an update restart with keep-shells on, the agent keeps running with the same PID and is not resumed', async () => {
  test.setTimeout(180_000)
  const l = layout()
  const github = await startFakeGitHub(l.files, l.digest)
  const dataHome = mkdtempSync('/tmp/ostia-ks-')
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    behavior: { gpuAcceleration: false, updateChannel: 'beta' },
    terminal: { keepShells: true },
    agents: { autoResume: true },
  })
  const bin = fakeAgentBin(dataHome, [
    '#!/bin/sh',
    'case "$*" in',
    '  *--resume*) echo "fake-agent-resumed $*" ;;',
    `  *) ${RESUME_TOKEN} e2e-update-kept-1 >/dev/null 2>&1; echo "fake-agent-ready pid=$$" ;;`,
    'esac',
    'exec cat',
  ])
  const env = { ...macEnv(github, l.bundle), PATH: `${bin}:${process.env.PATH}` }
  const first = await launch(dataHome, env)
  let pid = 0
  let closed = false
  try {
    await openWorkspace(first.win)
    await runInTerminal(first.win, 'claude')
    const screen = first.win.locator('.xterm-rows').first()
    await expect(screen).toContainText(/fake-agent-ready pid=\d+/, { timeout: 15_000 })
    pid = Number(/fake-agent-ready pid=(\d+)/.exec((await screen.textContent()) ?? '')?.[1])
    expect(pid).toBeGreaterThan(0)
    await expect
      .poll(() => savedPanes(dataHome).some((p) => p.agentRunning === true), { timeout: 15_000 })
      .toBe(true)
    await downloadAndStage(first.win)
    await restartFromNotice(first.app, first.win, dataHome)
    closed = true
  } finally {
    if (!closed) await quitApp(first.app)
  }
  expect(versionIn(l.bundle)).toBe(BETA)
  expect(() => process.kill(pid, 0)).not.toThrow()

  const second = await launch(dataHome, env)
  try {
    const screen = second.win.locator('.xterm-rows').first()
    await expect(screen).toContainText(`fake-agent-ready pid=${pid}`, { timeout: 30_000 })
    await second.win.waitForTimeout(2000)
    expect(() => process.kill(pid, 0)).not.toThrow()
    await expect(second.win.locator('.xterm-rows').filter({ hasText: '--resume' })).toHaveCount(0)
    expect(savedPanes(dataHome).some((p) => p.agentRunning === true)).toBe(true)
  } finally {
    await quitApp(second.app)
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
    await github.close()
    rmSync(dataHome, { recursive: true, force: true })
  }
})

function runningVersion(): string {
  const root = join(__dirname, '..')
  const built = join(root, 'out', 'build-info.json')
  const version = existsSync(built)
    ? JSON.parse(readFileSync(built, 'utf8')).version
    : JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  return String(version).replace(/\+.*$/, '')
}

test('a staged copy and an old app left by an earlier update are deleted at launch, app.asar included', async () => {
  test.setTimeout(120_000)
  const l = layout()
  appBundle(stagedOf(l.bundle), BETA)
  appBundle(`${l.bundle}.old`, INSTALLED)
  const github = await startFakeGitHub(l.files, l.digest)
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    behavior: { gpuAcceleration: false, updateChannel: 'beta' },
  })
  mkdirSync(join(dataHome, 'ostia'), { recursive: true })
  writeFileSync(
    join(dataHome, 'ostia', 'install-replace.json'),
    JSON.stringify({ appDir: l.bundle, version: runningVersion() }),
  )
  const { app, win } = await launch(dataHome, macEnv(github, l.bundle))
  try {
    await expect
      .poll(() => readdirSync(join(l.bundle, '..')).sort(), { timeout: 20_000 })
      .toEqual(['Ostia.app'])
    expect(mainLog(dataHome)).not.toMatch(/update-staged-discard-failed|install-sweep-failed/)
    await downloadAndStage(win)
    expect(versionIn(stagedOf(l.bundle))).toBe(BETA)
  } finally {
    await quitApp(app)
    await github.close()
  }
})
