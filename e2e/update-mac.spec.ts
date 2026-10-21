import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { withAsar } from './fakeAsar'
import { expectHeld, openWorkspace, quitApp, runInTerminal, stubExternalOpener } from './helpers'
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  stopTrace,
  test,
  waitForExit,
} from './test'

test.skip(process.platform !== 'darwin', 'app bundles, hdiutil and codesign are macOS only')

const BETA = '999.0.0-rc.1'
const INSTALLED = '1.0.0'
const BUNDLE_ID = 'ai.aurigax.ostia'
const DMG = `ostia-${BETA}-arm64.dmg`
const DOWNLOAD = `/aurigax-ai/ostia/releases/download/v${BETA}`

function plist(version: string): string {
  const entries: Record<string, string> = {
    CFBundleExecutable: 'Ostia',
    CFBundleIdentifier: BUNDLE_ID,
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

function appBundle(bundle: string, version: string): string {
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(join(bundle, 'Contents', 'Resources'), { recursive: true })
  copyFileSync('/usr/bin/true', join(bundle, 'Contents', 'MacOS', 'Ostia'))
  withAsar(join(bundle, 'Contents', 'Resources'))
  chmodSync(join(bundle, 'Contents', 'MacOS', 'Ostia'), 0o755)
  writeFileSync(join(bundle, 'Contents', 'Info.plist'), plist(version))
  writeFileSync(
    join(bundle, 'Contents', 'Resources', 'build-info.json'),
    JSON.stringify({ version, builtAt: '2026-10-13T00:00:00Z' }),
  )
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle])
  return bundle
}

function diskImage(root: string): Buffer {
  const stage = join(root, 'image')
  appBundle(join(stage, 'Ostia.app'), BETA)
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

type Release = Pick<Layout, 'files' | 'digest'>

let release: Release
let releaseRoot: string

test.beforeAll(() => {
  releaseRoot = mkdtempSync(join(tmpdir(), 'ostia-e2e-mac-release-'))
  const dmg = diskImage(releaseRoot)
  release = {
    digest: sha256(dmg),
    files: {
      [`${DOWNLOAD}/${DMG}`]: dmg,
      [`${DOWNLOAD}/SHA256SUMS`]: Buffer.from(`${sha256(dmg)}  ${DMG}\n`),
    },
  }
})

test.afterAll(() => {
  rmSync(releaseRoot, { recursive: true, force: true })
})

function layout(): Layout {
  const root = mkdtempSync(join(tmpdir(), 'ostia-e2e-mac-update-'))
  const bundle = appBundle(join(root, 'Applications', 'Ostia.app'), INSTALLED)
  return { root, bundle, ...release }
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

async function startFakeGitHub(files: Record<string, Buffer>, digest: string): Promise<FakeGitHub> {
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
    const latest = releaseEntry('0.0.1', null)
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

function macEnv(github: FakeGitHub, bundle: string): Record<string, string> {
  return {
    OSTIA_RELEASE_API_URL: github.url,
    OSTIA_RELEASE_DOWNLOAD_BASE_URL: github.url,
    OSTIA_INSTALL_METHOD: 'dmg',
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

async function restartFromNotice(
  app: ElectronApplication,
  win: Page,
  dataHome: string,
): Promise<void> {
  await app.evaluate(({ app: electronApp }) => {
    electronApp.relaunch = () => undefined
  })
  await stopTrace(app)
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
    await stopTrace(second.app)
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
    await runInTerminal(second.win, 'flush_marker')
    await expect(screen).toContainText('flush_marker', { timeout: 15_000 })
    await expectHeld(
      async () => ({
        alive: (() => {
          try {
            process.kill(pid, 0)
            return true
          } catch {
            return false
          }
        })(),
        resumes: await second.win.locator('.xterm-rows').filter({ hasText: '--resume' }).count(),
      }),
      { alive: true, resumes: 0 },
      2_000,
    )
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
