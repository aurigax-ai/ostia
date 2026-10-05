import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'

async function listen(
  onRequest: (url: string) => void,
): Promise<{ port: number; close: () => void }> {
  const server = createServer((req, res) => {
    onRequest(req.url ?? '')
    res.setHeader('content-type', 'text/html')
    res.end('<title>Ostia settings page</title><h1>hello</h1>')
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  return { port: (server.address() as AddressInfo).port, close: () => server.close() }
}

async function openEditorFile(win: Page, name: string): Promise<void> {
  await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
  await win.locator('.file-row').filter({ hasText: name }).click()
  await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 15_000 })
}

async function launchWithHome(dataHome: string) {
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  return { app, home }
}

test('the address bar searches with the chosen engine template', async () => {
  const requests: string[] = []
  const server = await listen((url) => requests.push(url))
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    browser: {
      searchEngine: 'custom',
      customSearchUrl: `http://127.0.0.1:${server.port}/find?term={query}`,
    },
  })
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.getByRole('button', { name: 'New browser tab' }).click()
    const address = win.locator('.pane-slot:not([data-hidden]) .browser-address')
    await address.fill('hello ostia world')
    await address.press('Enter')
    await expect
      .poll(() => requests, { timeout: 15_000 })
      .toContain('/find?term=hello%20ostia%20world')
    await expect(address).toHaveValue(
      `http://127.0.0.1:${server.port}/find?term=hello%20ostia%20world`,
    )
  } finally {
    await app.close()
    server.close()
  }
})

test('Ctrl+click on a terminal web link opens a browser pane when the setting is on', async () => {
  test.setTimeout(60_000)
  const requests: string[] = []
  const server = await listen((url) => requests.push(url))
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, browser: { openTerminalLinks: true } })
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.locator('.xterm').first().click()
    await win.keyboard.type(`clear; printf 'open http://127.0.0.1:${server.port}/linked\\n'`)
    await win.keyboard.press('Enter')

    const rows = win.locator('.xterm-rows').first()
    const row = rows
      .locator('div', { hasText: /^open http:\/\/127\.0\.0\.1:\d+\/linked\s*$/ })
      .first()
    await expect(row).toHaveCount(1, { timeout: 15_000 })
    await expect(
      row
        .locator('xpath=following-sibling::div')
        .filter({ hasText: /[❯$%#]/ })
        .first(),
    ).toBeAttached({ timeout: 15_000 })
    const target = await row.evaluate((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent?.indexOf('/linked') ?? -1
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + 1)
        const rect = range.getBoundingClientRect()
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      }
      return null
    })
    if (!target) throw new Error('link text not found in the row')

    await win.mouse.move(target.x, target.y)
    await win.keyboard.down('Control')
    await win.mouse.click(target.x, target.y)
    await win.keyboard.up('Control')

    await expect(win.locator('.browser-address')).toHaveValue(
      `http://127.0.0.1:${server.port}/linked`,
      { timeout: 15_000 },
    )
    await expect.poll(() => requests, { timeout: 15_000 }).toContain('/linked')
  } finally {
    await app.close()
    server.close()
  }
})

test('word wrap and tab width from Settings apply to the open editor', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  const { app, home } = await launchWithHome(dataHome)
  const file = join(home, 'wide.txt')
  writeFileSync(file, `${'word '.repeat(400)}\nsecond\n`)
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await openEditorFile(win, 'wide.txt')

    const firstLine = win.locator('.monaco-editor .view-line > span').first()
    const unwrapped = (await firstLine.boundingBox())?.width ?? 0
    expect(unwrapped).toBeGreaterThan(0)

    await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
    const settings = win.getByRole('region', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Editor', exact: true }).click()
    await settings.getByRole('switch', { name: 'Word wrap' }).click()
    await settings.getByRole('combobox', { name: 'Tab width' }).click()
    await win.getByRole('option', { name: '4', exact: true }).click()
    await win.keyboard.press('Escape')

    await expect
      .poll(async () => (await firstLine.boundingBox())?.width ?? 0)
      .toBeLessThan(unwrapped / 2)

    await win.locator('.monaco-editor .view-lines').first().click()
    await win.keyboard.press('Control+Home')
    await win.keyboard.press('Tab')
    await win.keyboard.press('Control+s')
    await expect
      .poll(() => readFileSync(file, 'utf8').startsWith(`${' '.repeat(4)}word `))
      .toBe(true)
  } finally {
    await app.close()
  }
})

test('auto save afterDelay writes the edited file without Ctrl+S', async () => {
  test.setTimeout(60_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, editor: { autoSave: 'afterDelay' } })
  const { app, home } = await launchWithHome(dataHome)
  const file = join(home, 'auto.txt')
  writeFileSync(file, 'start\n')
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await openEditorFile(win, 'auto.txt')

    await win.locator('.monaco-editor .view-lines').first().click()
    await win.keyboard.press('Control+End')
    await win.keyboard.type('saved-by-timer')

    await expect
      .poll(() => readFileSync(file, 'utf8'), { timeout: 10_000 })
      .toContain('saved-by-timer')
  } finally {
    await app.close()
  }
})
