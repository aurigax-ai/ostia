import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PRODUCT_NAME } from '../src/shared/product'
import { installFakeLanguageExtension } from '../test/fixtures/lsp/installFakeExtension'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { hoverInEditor, openWorkspace } from './helpers'
import {
  type ElectronApplication,
  type Locator,
  type Page,
  _electron as electron,
  expect,
  test,
} from './test'

const FAKE_SYSTEM_BIN = resolve(__dirname, '../test/fixtures/system/bin')

interface Launched {
  app: ElectronApplication
  win: Page
  home: string
  project: string
}

async function launch(files: Record<string, string>, fixture = 'fake-lang'): Promise<Launched> {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  const project = join(home, 'project')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(home, 'secret.txt'), 'TOP-SECRET\n')
  for (const [name, text] of Object.entries(files)) writeFileSync(join(project, name), text)
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    workspaces: { ...DOM_RENDERER_SETTINGS.workspaces, defaultFolder: project },
  })
  const options = isolatedLaunch(dataHome)
  installFakeLanguageExtension(
    join(options.env.XDG_CONFIG_HOME, PRODUCT_NAME, 'extensions'),
    fixture,
  )
  const app = await electron.launch({
    ...options,
    env: { ...options.env, HOME: home, PATH: `${FAKE_SYSTEM_BIN}:${process.env.PATH}` },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win, home, project }
}

async function approveFakeLanguage(win: Page): Promise<void> {
  const approval = win.getByRole('dialog').filter({ hasText: 'Fake language' })
  await expect(approval).toBeVisible({ timeout: 15_000 })
  await expect(approval.getByRole('list', { name: 'Language servers' })).toContainText(
    'Runs server/fake-server.cjs',
  )
  await approval.getByRole('button', { name: 'Approve and enable' }).click()
  await expect(approval).toBeHidden()
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

async function openLanguages(win: Page): Promise<Locator> {
  await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
  const settings = win.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Languages', exact: true }).click()
  return settings
}

function fakeRow(settings: Locator): Locator {
  return settings.getByRole('listitem', { name: 'Fake server' })
}

async function hoverText(win: Page, editor: Locator, text: string): Promise<Locator> {
  const target = editor.locator('.view-line span span').filter({ hasText: text }).first()
  await hoverInEditor(win, target, { x: 4, y: 8 })
  const hover = win.locator('.monaco-hover:visible')
  await expect(hover).toBeVisible({ timeout: 10_000 })
  return hover
}

test('in a sandboxed workspace the server runs wrapped and cannot read a file under home', async () => {
  test.setTimeout(90_000)
  const { app, win, home, project } = await launch({})
  writeFileSync(
    join(project, 'probe.txt'),
    `READ ${join(home, 'secret.txt')}\nREAD ${join(project, 'inside.txt')}\n`,
  )
  writeFileSync(join(project, 'inside.txt'), 'in the project\n')
  try {
    await approveFakeLanguage(win)
    await openWorkspace(win)
    await win.locator('.rail-row').first().click({ button: 'right' })
    await win.getByRole('menuitemcheckbox', { name: 'Sandbox' }).click()
    const editor = await openFile(win, 'probe.txt')
    await expect(editor.locator('.squiggly-info')).toHaveCount(2, { timeout: 30_000 })
    const denied = await hoverText(win, editor, 'secret.txt')
    await expect(denied).toContainText('read failed')
    await win.keyboard.press('Escape')

    const settings = await openLanguages(win)
    await fakeRow(settings).getByRole('button', { name: 'Show the log of Fake server' }).click()
    await expect(win.getByRole('dialog').filter({ hasText: 'Log of Fake server' })).toContainText(
      'Started in the sandbox',
    )
  } finally {
    await app.close()
  }
})
