import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { withAsar } from './fakeAsar'
import { emptyState, openedExternally, openWorkspace, PROMPT, stubExternalOpener } from './helpers'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from './test'

const VERSION = '999.0.0'
const RELEASE_URL = `https://github.com/aurigax-ai/ostia/releases/tag/v${VERSION}`
const FAKE_BIN = resolve(__dirname, '../test/fixtures/system/bin')

interface FakeGitHub {
  url: string
  close: () => Promise<void>
}

async function startFakeGitHub(files: Record<string, Buffer> = {}): Promise<FakeGitHub> {
  const server: Server = createServer((req, res) => {
    const file = files[req.url ?? '']
    if (file) {
      res.writeHead(200, { 'content-length': file.byteLength })
      res.end(file)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        tag_name: `v${VERSION}`,
        html_url: RELEASE_URL,
        draft: false,
        prerelease: false,
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
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
    await dialog.getByRole('button', { name: 'Open terminal' }).click()

    await expect(win.locator('.ghostty-host')).toHaveCount(2, { timeout: 20_000 })
    const updater = win.locator('.terminal-text').filter({ hasText: 'fake apt installed' })
    await expect(updater).toContainText('fake apt installed: update', { timeout: 20_000 })
    await expect(updater).toContainText('fake apt installed: install --only-upgrade ostia')
    await expect(updater).toContainText(PROMPT)
    await expect(notice.getByRole('button', { name: 'Restart Ostia' })).toBeVisible({
      timeout: 15_000,
    })
    expect(await openedExternally(app)).toEqual([])
  } finally {
    await app.close()
    await github.close()
  }
})

function appFolder(dir: string, version: string): void {
  withAsar(join(dir, 'resources'))
  writeFileSync(join(dir, 'ostia'), '#!/bin/sh\n', { mode: 0o755 })
  writeFileSync(
    join(dir, 'resources', 'build-info.json'),
    JSON.stringify({ version, builtAt: '2026-10-07T00:00:00Z' }),
  )
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

interface ReplaceLayout {
  appDir: string
  files: Record<string, Buffer>
}

function replaceLayout(): ReplaceLayout {
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
      [`${base}/SHA256SUMS`]: Buffer.from(`${sha256(archive)}  ${top}.tar.gz\n`),
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
  const layout = replaceLayout()
  const github = await startFakeGitHub(layout.files)
  const { app, win } = await launch(github, freshDataHome(), replaceEnv(github, layout.appDir))
  try {
    const notice = win.locator('.update-notice')
    await notice.getByRole('button', { name: 'Download and install' }).click({ timeout: 20_000 })
    await expect(notice.getByRole('button', { name: 'Restart Ostia' })).toBeVisible({
      timeout: 30_000,
    })
    expect(versionIn(layout.appDir)).toBe(VERSION)
    expect(await openedExternally(app)).toEqual([])
  } finally {
    await app.close()
    await github.close()
  }
})
