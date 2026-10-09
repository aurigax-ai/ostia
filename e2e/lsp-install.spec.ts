import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'
import { type Locator, type Page, _electron as electron, expect, test } from './test'

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
