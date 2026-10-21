import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { centerOf, dragFiles, dropFiles } from './osDrag'
import { type ElectronApplication, _electron as electron, expect, test } from './test'

const SHIFT = 8

const DROP_PAGE = `<!doctype html><title>waiting</title>
<p style="position:fixed;inset:0;margin:0">drop here</p>
<script>
addEventListener('dragover', (e) => {
  e.preventDefault()
  if (document.title === 'waiting') document.title = 'over'
})
addEventListener('drop', async (e) => {
  e.preventDefault()
  const files = [...e.dataTransfer.files]
  const texts = await Promise.all(files.map((file) => file.text()))
  document.title = 'dropped ' + files.map((file, i) => file.name + '=' + texts[i].trim()).join(',')
})
</script>`

function guestAttached(webview: Element): boolean {
  try {
    ;(webview as unknown as { getWebContentsId(): number }).getWebContentsId()
    return true
  } catch {
    return false
  }
}

function serve(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(DROP_PAGE)
  })
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      ok({ server, url: `http://127.0.0.1:${port}/upload` })
    }),
  )
}

function guestPage(
  app: ElectronApplication,
  url: string,
): Promise<{ title: string; url: string }[]> {
  return app.evaluate(({ webContents }, at) => {
    return webContents
      .getAllWebContents()
      .filter((wc) => wc.getType() === 'webview' && wc.getURL().startsWith(at))
      .map((wc) => ({ title: wc.getTitle(), url: wc.getURL() }))
  }, url)
}

test('a file dropped from the system onto a web page in a browser pane reaches the page', async () => {
  const dataHome = freshDataHome()
  const outside = join(dataHome, 'outside')
  mkdirSync(outside, { recursive: true })
  const notes = join(outside, 'notes.txt')
  const photo = join(outside, 'photo.txt')
  writeFileSync(notes, 'hello page\n')
  writeFileSync(photo, 'second file\n')
  const { server, url } = await serve()
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.getByRole('button', { name: 'New browser tab', exact: true }).first().click()
    const address = win.locator('.pane-slot:not([data-hidden]) .browser-address')
    await expect(address).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(() => win.locator('webview:visible').evaluate(guestAttached), { timeout: 15_000 })
      .toBe(true)
    await address.fill(url)
    await address.press('Enter')
    await expect
      .poll(async () => (await guestPage(app, url))[0]?.title, { timeout: 15_000 })
      .toBe('waiting')

    const page = await centerOf(win.locator('webview:visible'))
    const drag = await dragFiles(win, [notes, photo])
    await expect
      .poll(async () => {
        await drag.send('dragCancel', page)
        await drag.send('dragEnter', page)
        await drag.send('dragOver', page)
        return (await guestPage(app, url))[0]?.title
      })
      .toBe('over')
    await drag.send('drop', page)
    await drag.done()

    await expect
      .poll(async () => (await guestPage(app, url))[0]?.title, { timeout: 10_000 })
      .toBe('dropped notes.txt=hello page,photo.txt=second file')
    expect(await guestPage(app, url)).toEqual([
      { title: 'dropped notes.txt=hello page,photo.txt=second file', url },
    ])
    await expect(win.locator('.monaco-editor')).toHaveCount(0)
    expect(await win.evaluate((path) => window.ostia.fs.read(path), notes)).toEqual({
      ok: false,
      error: 'denied',
    })
  } finally {
    await app.close()
    server.close()
  }
})

function contentOf(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

test('a file dropped from the system onto a Files folder is copied in, never over an existing one, and Shift moves it', async () => {
  const dataHome = freshDataHome()
  const launch = isolatedLaunch(dataHome)
  const folder = join(launch.home, 'src')
  mkdirSync(folder, { recursive: true })
  const outside = join(dataHome, 'outside')
  mkdirSync(outside, { recursive: true })
  const report = join(outside, 'report.txt')
  writeFileSync(report, 'first\n')
  mkdirSync(join(outside, 'later'))
  const later = join(outside, 'later', 'report.txt')
  writeFileSync(later, 'second\n')
  const app = await electron.launch(launch)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    const row = win.locator('.file-row').filter({ hasText: /^src$/ })
    await expect(row).toBeVisible({ timeout: 15_000 })

    await dropFiles(win, [report], await centerOf(row))
    await expect.poll(() => contentOf(join(folder, 'report.txt'))).toBe('first\n')
    expect(readFileSync(report, 'utf8')).toBe('first\n')

    await dropFiles(win, [later], await centerOf(row))
    await expect.poll(() => contentOf(join(folder, 'report (2).txt'))).toBe('second\n')
    expect(contentOf(join(folder, 'report.txt'))).toBe('first\n')

    await dropFiles(win, [later], await centerOf(row), SHIFT)
    await expect.poll(() => existsSync(later)).toBe(false)
    await expect.poll(() => contentOf(join(folder, 'report (3).txt'))).toBe('second\n')

    await row.click()
    await expect(win.locator('.file-row').filter({ hasText: 'report (3).txt' })).toBeVisible()
    await expect(win.locator('.pane-tab').filter({ hasText: 'report' })).toHaveCount(0)
  } finally {
    await app.close()
  }
})
