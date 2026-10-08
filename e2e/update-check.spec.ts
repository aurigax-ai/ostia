import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { PROMPT, emptyState, openWorkspace, openedExternally, stubExternalOpener } from './helpers'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

const VERSION = '999.0.0'
const RELEASE_URL = `https://github.com/aurigax-ai/ostia/releases/tag/v${VERSION}`
const MAIN_VERSION = '999.0.1-main.5'
const MAIN_URL = `https://github.com/aurigax-ai/ostia/releases/tag/v${MAIN_VERSION}`
const STARTUP_CHECK_MS = 5_000
const FAKE_BIN = resolve(__dirname, '../test/fixtures/system/bin')
const APT_COMMAND = 'sudo apt update && sudo apt install --only-upgrade ostia'

interface FakeGitHub {
  url: string
  requests: Array<{ path: string | undefined; userAgent: string | undefined }>
  close: () => Promise<void>
}

async function startFakeGitHub(files: Record<string, Buffer> = {}): Promise<FakeGitHub> {
  const requests: FakeGitHub['requests'] = []
  const server: Server = createServer((req, res) => {
    const file = files[req.url ?? '']
    if (file) {
      res.writeHead(200, { 'content-length': file.byteLength })
      res.end(file)
      return
    }
    requests.push({ path: req.url, userAgent: req.headers['user-agent'] })
    res.writeHead(200, { 'content-type': 'application/json' })
    const stable = {
      tag_name: `v${VERSION}`,
      html_url: RELEASE_URL,
      draft: false,
      prerelease: false,
    }
    const main = {
      tag_name: `v${MAIN_VERSION}`,
      html_url: MAIN_URL,
      draft: false,
      prerelease: true,
    }
    res.end(JSON.stringify(req.url?.includes('/releases?') ? [main, stable] : stable))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

async function launch(
  github: FakeGitHub,
  dataHome: string,
  env: Record<string, string> = {},
): Promise<{ app: ElectronApplication; win: Page }> {
  const launchOptions = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launchOptions,
    env: { ...launchOptions.env, OSTIA_RELEASE_API_URL: github.url, ...env },
  })
  const win = await app.firstWindow()
  await stubExternalOpener(app)
  await win.waitForLoadState('domcontentloaded')
  await expect(emptyState(win)).toBeVisible({ timeout: 15_000 })
  return { app, win }
}

const releaseButton = (win: Page) =>
  win.locator('.update-notice').getByRole('button', { name: `Version ${VERSION} is available` })

async function openAbout(win: Page) {
  await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
  const settings = win.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'About' }).click()
  return settings
}

test('a newer release shows a notice that opens its page and stays skipped after a restart', async () => {
  const github = await startFakeGitHub()
  const dataHome = freshDataHome()
  let { app, win } = await launch(github, dataHome)
  try {
    await expect(releaseButton(win)).toBeVisible({ timeout: 20_000 })
    expect(github.requests).toHaveLength(1)
    expect(github.requests[0].path).toBe('/repos/aurigax-ai/ostia/releases/latest')
    expect(github.requests[0].userAgent).toMatch(/^ostia\/\d+\.\d+\.\d+/)

    await releaseButton(win).click()
    await expect.poll(() => openedExternally(app)).toEqual([RELEASE_URL])

    await win.locator('.update-notice').getByRole('button', { name: 'Skip this version' }).click()
    await expect(win.locator('.update-notice')).toHaveCount(0)

    await app.close()
    ;({ app, win } = await launch(github, dataHome))
    await expect.poll(() => github.requests.length, { timeout: 20_000 }).toBe(2)
    const settings = await openAbout(win)
    await settings.getByRole('button', { name: 'Check for updates' }).click()
    await expect(settings.getByText(`Version ${VERSION} is available`)).toBeVisible()
    await expect(win.locator('.update-notice')).toHaveCount(0)
  } finally {
    await app.close()
    await github.close()
  }
})

test('with the automatic check off nothing is asked until the human checks from About', async () => {
  const github = await startFakeGitHub()
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    behavior: { ...DOM_RENDERER_SETTINGS.behavior, checkForUpdates: false },
  })
  const { app, win } = await launch(github, dataHome)
  try {
    const settings = await openAbout(win)
    await expect(
      settings.getByRole('switch', { name: 'Check for updates automatically' }),
    ).not.toBeChecked()
    await win.waitForTimeout(STARTUP_CHECK_MS + 2_000)
    expect(github.requests).toHaveLength(0)

    await settings.getByRole('button', { name: 'Check for updates' }).click()
    await expect(settings.getByText(`Version ${VERSION} is available`)).toBeVisible()
    expect(github.requests).toHaveLength(1)

    await settings.getByRole('button', { name: 'View release' }).click()
    await expect.poll(() => openedExternally(app)).toEqual([RELEASE_URL])
  } finally {
    await app.close()
    await github.close()
  }
})

test('an apt install offers Update with apt, runs the exact command after a confirm and then offers a restart', async () => {
  const github = await startFakeGitHub()
  const dataHome = freshDataHome()
  const { app, win } = await launch(github, dataHome, {
    OSTIA_INSTALL_METHOD: 'apt',
    PATH: `${FAKE_BIN}:${process.env.PATH}`,
  })
  try {
    await openWorkspace(win)
    const notice = win.locator('.update-notice')
    await expect(notice.getByRole('button', { name: 'Update with apt' })).toBeVisible({
      timeout: 20_000,
    })
    await notice.getByRole('button', { name: 'Update with apt' }).click()

    const dialog = win.getByRole('dialog', { name: 'Update Ostia with apt' })
    await expect(dialog).toContainText(APT_COMMAND)
    await expect(win.locator('.xterm')).toHaveCount(1)
    await dialog.getByRole('button', { name: 'Open terminal' }).click()

    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 20_000 })
    const updater = win.locator('.xterm-rows').filter({ hasText: 'fake apt installed' })
    await expect(updater).toContainText('fake apt installed: update', { timeout: 20_000 })
    await expect(updater).toContainText('fake apt installed: install --only-upgrade ostia')
    await expect(updater).toContainText(PROMPT)
    await expect(notice.getByRole('button', { name: 'Restart Ostia' })).toBeVisible({
      timeout: 15_000,
    })
    expect(await openedExternally(app)).toEqual([])

    const settings = await openAbout(win)
    await expect(settings.getByText('Installed with apt')).toBeVisible()
    await expect(settings.getByRole('button', { name: 'Restart Ostia' })).toBeVisible()
  } finally {
    await app.close()
    await github.close()
  }
})

function appFolder(dir: string, version: string): void {
  mkdirSync(join(dir, 'resources'), { recursive: true })
  writeFileSync(join(dir, 'ostia'), '#!/bin/sh\n', { mode: 0o755 })
  writeFileSync(
    join(dir, 'resources', 'build-info.json'),
    JSON.stringify({ version, builtAt: '2026-10-07T00:00:00Z' }),
  )
}

interface ReplaceLayout {
  appDir: string
  files: Record<string, Buffer>
}

function replaceLayout(checksum: (archive: Buffer) => string): ReplaceLayout {
  const root = mkdtempSync(join(tmpdir(), 'ostia-e2e-replace-'))
  const appDir = join(root, 'apps', 'ostia')
  appFolder(appDir, '1.0.0')
  const top = `ostia-${VERSION}-linux-x64`
  appFolder(join(root, 'stage', top), VERSION)
  const file = join(root, 'stage', `${top}.tar.gz`)
  execFileSync('tar', ['-C', join(root, 'stage'), '-czf', file, top])
  const archive = readFileSync(file)
  const base = `/aurigax-ai/ostia/releases/download/v${VERSION}`
  return {
    appDir,
    files: {
      [`${base}/${top}.tar.gz`]: archive,
      [`${base}/SHA256SUMS`]: Buffer.from(`${checksum(archive)}  ${top}.tar.gz\n`),
    },
  }
}

const versionIn = (dir: string): string =>
  JSON.parse(readFileSync(join(dir, 'resources', 'build-info.json'), 'utf8')).version

function replaceEnv(github: FakeGitHub, appDir: string): Record<string, string> {
  return {
    OSTIA_INSTALL_METHOD: 'tarball',
    OSTIA_INSTALL_APP_DIR: appDir,
    OSTIA_RELEASE_DOWNLOAD_BASE_URL: github.url,
  }
}

test('a tarball install downloads the release, swaps the app folder and then offers a restart', async () => {
  const layout = replaceLayout((archive) => createHash('sha256').update(archive).digest('hex'))
  const github = await startFakeGitHub(layout.files)
  const { app, win } = await launch(github, freshDataHome(), replaceEnv(github, layout.appDir))
  try {
    const notice = win.locator('.update-notice')
    await notice.getByRole('button', { name: 'Download and install' }).click({ timeout: 20_000 })
    await expect(notice.getByRole('button', { name: 'Restart Ostia' })).toBeVisible({
      timeout: 30_000,
    })
    expect(versionIn(layout.appDir)).toBe(VERSION)
    expect(versionIn(`${layout.appDir}.old`)).toBe('1.0.0')
    expect(existsSync(`${layout.appDir}.new`)).toBe(false)
    expect(existsSync(`${layout.appDir}.download`)).toBe(false)
    expect(await openedExternally(app)).toEqual([])
  } finally {
    await app.close()
    await github.close()
  }
})

test('a wrong checksum leaves the app folder as it was and says why', async () => {
  const layout = replaceLayout(() => 'f'.repeat(64))
  const github = await startFakeGitHub(layout.files)
  const { app, win } = await launch(github, freshDataHome(), replaceEnv(github, layout.appDir))
  try {
    const notice = win.locator('.update-notice')
    await notice.getByRole('button', { name: 'Download and install' }).click({ timeout: 20_000 })
    const settings = await openAbout(win)
    await expect(
      settings.getByText('The downloaded archive didn’t match its checksum. Nothing was changed.'),
    ).toBeVisible({ timeout: 30_000 })
    expect(versionIn(layout.appDir)).toBe('1.0.0')
    expect(readdirSync(join(layout.appDir, '..'))).toEqual(['ostia'])
    await expect(settings.getByRole('button', { name: 'Download and install' })).toBeEnabled()
  } finally {
    await app.close()
    await github.close()
  }
})

test('a tarball install on the Main channel is offered the newest main build, and Stable again only releases', async () => {
  const github = await startFakeGitHub()
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    behavior: { ...DOM_RENDERER_SETTINGS.behavior, checkForUpdates: false },
  })
  const { app, win } = await launch(github, dataHome, { OSTIA_INSTALL_METHOD: 'tarball' })
  try {
    const settings = await openAbout(win)
    const picker = settings.getByRole('combobox', { name: 'Update channel' })
    await expect(picker).toContainText('Stable')
    await picker.click()
    await win.getByRole('option', { name: 'Main' }).click()
    await expect(picker).toContainText('Main')

    await settings.getByRole('button', { name: 'Check for updates' }).click()
    await expect(settings.getByText(`Version ${MAIN_VERSION} is available`)).toBeVisible()
    expect(github.requests.map((r) => r.path)).toEqual([
      '/repos/aurigax-ai/ostia/releases?per_page=30',
    ])

    await picker.click()
    await win.getByRole('option', { name: 'Stable' }).click()
    await expect(settings.getByText(`Version ${MAIN_VERSION} is available`)).toHaveCount(0)
    await settings.getByRole('button', { name: 'Check for updates' }).click()
    await expect(settings.getByText(`Version ${VERSION} is available`)).toBeVisible()
    expect(github.requests.at(-1)?.path).toBe('/repos/aurigax-ai/ostia/releases/latest')
  } finally {
    await app.close()
    await github.close()
  }
})

test('an apt install keeps the channel picker on Stable and says why', async () => {
  const github = await startFakeGitHub()
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    behavior: { ...DOM_RENDERER_SETTINGS.behavior, checkForUpdates: false, updateChannel: 'main' },
  })
  const { app, win } = await launch(github, dataHome, { OSTIA_INSTALL_METHOD: 'apt' })
  try {
    const settings = await openAbout(win)
    const picker = settings.getByRole('combobox', { name: 'Update channel' })
    await expect(picker).toContainText('Stable')
    await expect(picker).toBeDisabled()
    await expect(settings.getByText(/stay on Stable/)).toBeVisible()
    await settings.getByRole('button', { name: 'Check for updates' }).click()
    await expect(settings.getByText(`Version ${VERSION} is available`)).toBeVisible()
    expect(github.requests.map((r) => r.path)).toEqual(['/repos/aurigax-ai/ostia/releases/latest'])
  } finally {
    await app.close()
    await github.close()
  }
})
