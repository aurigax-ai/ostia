import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { type IncomingHttpHeaders, type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  type ElectronApplication,
  type Locator,
  type Page,
  _electron as electron,
  expect,
  test,
} from './test'
import { MARKETPLACE_MANIFEST_FILE } from '../src/shared/marketplace'
import { PRODUCT_NAME } from '../src/shared/product'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'

const FAKE_SERVER = resolve(__dirname, '../test/fixtures/lsp/fake-server.mjs')
const ASSET_PATH = '/ostia-test/fake-native/releases/download/1.0.0/fake-native.gz'
const asset = gzipSync(Buffer.from(`#!/bin/sh\nexec node ${FAKE_SERVER} "$@"\n`))

interface Fixture {
  server: Server
  baseUrl: string
  requests: { url: string; headers: IncomingHttpHeaders }[]
}

async function assetServer(): Promise<Fixture> {
  const requests: Fixture['requests'] = []
  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers })
    if (req.url !== ASSET_PATH) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-length': asset.length })
    res.end(asset)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return { server, baseUrl: `http://127.0.0.1:${port}`, requests }
}

function marketplaceRepo(dataHome: string): string {
  const repo = join(dataHome, 'marketplace-repo')
  const dir = join(repo, 'extensions', 'fake-native')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'ostia.json'),
    JSON.stringify({
      id: 'fake-native',
      name: 'Fake native',
      version: '1.0.0',
      api: '3.0',
      description: 'Test fixture: a language server the app downloads',
      category: 'languages',
      capabilities: ['language-server'],
      contributes: {
        languageServers: [
          {
            id: 'native',
            name: 'Fake native server',
            languages: ['plaintext'],
            run: {
              download: {
                program: 'ostia-fake-native-lsp',
                version: '1.0.0',
                assets: {
                  [`${process.platform}-${process.arch}`]: {
                    url: `https://github.com${ASSET_PATH}`,
                    sha256: createHash('sha256').update(asset).digest('hex'),
                    archive: 'gz',
                    executable: 'fake-native',
                  },
                },
              },
              args: ['--record={root}/.fake-lsp-record.jsonl'],
            },
          },
        ],
      },
    }),
  )
  writeFileSync(
    join(repo, MARKETPLACE_MANIFEST_FILE),
    JSON.stringify({ name: 'E2E marketplace', extensions: ['extensions/fake-native'] }),
  )
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', ...args], {
      cwd: repo,
      stdio: 'ignore',
    })
  }
  git('init', '-b', 'main')
  git('add', '-A')
  git('commit', '-m', 'marketplace')
  return repo
}

interface Launched {
  app: ElectronApplication
  win: Page
  dataHome: string
  project: string
  installed: string
  fixture: Fixture
}

async function launch(): Promise<Launched> {
  const fixture = await assetServer()
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  const project = join(home, 'project')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'notes.txt'), 'first ERROR\n')
  writeFileSync(join(project, 'other.txt'), 'plain\n')
  const repo = marketplaceRepo(dataHome)
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    workspaces: { ...DOM_RENDERER_SETTINGS.workspaces, defaultFolder: project },
  })
  const options = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...options,
    env: { ...options.env, HOME: home, OSTIA_LSP_DOWNLOAD_BASE_URL: fixture.baseUrl },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  await win.keyboard.press('Control+,')
  const settings = win.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Browse extensions', exact: true }).click()
  await settings.getByRole('textbox', { name: 'Marketplace repository' }).fill(repo)
  await settings.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(settings.getByRole('listitem', { name: 'E2E marketplace' })).toBeVisible({
    timeout: 15_000,
  })
  await win.keyboard.press('Escape')
  return {
    app,
    win,
    dataHome,
    project,
    fixture,
    installed: join(options.env.XDG_CONFIG_HOME, PRODUCT_NAME, 'extensions', 'fake-native'),
  }
}

async function openFile(win: Page, name: string): Promise<Locator> {
  const files = win.locator('.file-row')
  if ((await files.count()) === 0) {
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
  }
  await files.filter({ hasText: name }).click()
  const editor = win.locator('.monaco-editor:visible').first()
  await expect(editor).toBeVisible({ timeout: 15_000 })
  return editor
}

test('opening a file offers the extension, installs it on the human’s click, and the app downloads its server', async () => {
  test.setTimeout(90_000)
  const { app, win, dataHome, installed, fixture } = await launch()
  try {
    const editor = await openFile(win, 'notes.txt')
    const notice = win.getByRole('status', { name: 'Language features' })
    await expect(notice).toContainText('Fake native adds language features for .txt files.', {
      timeout: 15_000,
    })
    expect(existsSync(installed)).toBe(false)
    expect(fixture.requests).toHaveLength(0)

    await notice.getByRole('button', { name: 'Install' }).click()
    const approval = win.getByRole('dialog').filter({ hasText: 'Fake native' })
    await expect(approval).toBeVisible({ timeout: 15_000 })
    await expect(approval).toContainText(
      'Downloads ostia-fake-native-lsp 1.0.0 from github.com when it is not on your PATH',
    )
    expect(existsSync(join(installed, 'ostia.json'))).toBe(true)
    expect(fixture.requests).toHaveLength(0)
    await expect(editor.locator('.squiggly-error')).toHaveCount(0)

    await approval.getByRole('button', { name: 'Approve and enable' }).click()
    await expect(editor.locator('.squiggly-error')).toHaveCount(1, { timeout: 30_000 })
    await expect(notice).toHaveCount(0)

    expect(fixture.requests.map((r) => r.url)).toEqual([ASSET_PATH])
    expect(fixture.requests[0].headers['user-agent']).toMatch(/^ostia\/\d+\.\d+\.\d+/)
    expect(fixture.requests[0].headers.cookie).toBeUndefined()
    const copy = join(dataHome, 'userData', 'language-servers', 'fake-native', 'native')
    expect(readdirSync(copy)).toEqual(['1.0.0'])
    expect(readdirSync(join(copy, '1.0.0'))).toEqual(['fake-native'])

    await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
    const settings = win.getByRole('region', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Languages', exact: true }).click()
    const row = settings.getByRole('listitem', { name: 'Fake native server' })
    await expect(row.getByTestId('language-server-status')).toHaveText('Running (1 folder)')
    await expect(row).toContainText('Using the copy Ostia keeps, version 1.0.0.')
    await row.getByRole('button', { name: 'Show the log of Fake native server' }).click()
    const log = win.getByRole('dialog').filter({ hasText: 'Log of Fake native server' })
    await expect(log).toContainText('Downloading version 1.0.0')
    await expect(log).toContainText('Version 1.0.0 is ready')
    await win.keyboard.press('Escape')

    await row
      .getByRole('button', { name: 'Remove the copy of Fake native server that Ostia keeps' })
      .click()
    await expect.poll(() => existsSync(copy), { timeout: 15_000 }).toBe(false)
  } finally {
    await app.close()
    fixture.server.close()
  }
})

test('saying No hides the offer for that extension, also after reopening the file', async () => {
  const { app, win, installed, fixture } = await launch()
  try {
    await openFile(win, 'notes.txt')
    const notice = win.getByRole('status', { name: 'Language features' })
    await expect(notice).toContainText('Fake native adds language features', { timeout: 15_000 })
    await notice.getByRole('button', { name: 'No' }).click()
    await expect(notice).toHaveCount(0)

    await openFile(win, 'other.txt')
    await expect(win.locator('.monaco-editor:visible .view-lines')).toContainText('plain')
    await openFile(win, 'notes.txt')
    await expect(win.locator('.monaco-editor:visible .view-lines')).toContainText('first ERROR')
    await expect(notice).toHaveCount(0)
    expect(existsSync(installed)).toBe(false)
    expect(fixture.requests).toHaveLength(0)
  } finally {
    await app.close()
    fixture.server.close()
  }
})

test('a fresh install with no marketplace still names the extension for a TypeScript file, which is only highlighted', async () => {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  const project = join(home, 'project')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'main.ts'), "export const count: number = 'three'\n")
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    workspaces: { ...DOM_RENDERER_SETTINGS.workspaces, defaultFolder: project },
  })
  const options = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...options, env: { ...options.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const editor = await openFile(win, 'main.ts')
    const notice = win.getByRole('status', { name: 'Language features' })
    await expect(notice).toContainText('lsp-typescript adds language features for .ts files.', {
      timeout: 15_000,
    })
    await expect(notice.getByRole('button', { name: 'Install' })).toBeVisible()
    await expect(notice.getByRole('button', { name: 'No' })).toBeVisible()

    const classOf = (text: RegExp): Promise<string | null> =>
      editor.locator('.view-line span span').filter({ hasText: text }).first().getAttribute('class')
    const keyword = await classOf(/^export$/)
    const text = await classOf(/'three'/)
    expect(keyword).toMatch(/mtk\d+/)
    expect(text).toMatch(/mtk\d+/)
    expect(keyword).not.toBe(text)
    await expect(editor.locator('.squiggly-error')).toHaveCount(0)

    const box = await win.locator('.editor-host:visible').boundingBox()
    const bar = await notice.boundingBox()
    expect(box && bar && box.y >= bar.y + bar.height - 1).toBe(true)
  } finally {
    await app.close()
  }
})
