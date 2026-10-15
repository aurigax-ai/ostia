import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { installFakeLanguageExtension } from '../test/fixtures/lsp/installFakeExtension'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'
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

test('in a sandboxed workspace the server’s diagnostics show as squiggles', async () => {
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
  } finally {
    await app.close()
  }
})
