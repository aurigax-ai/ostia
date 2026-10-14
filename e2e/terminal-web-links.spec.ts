import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, openedExternally, stubExternalOpener } from './helpers'
import { clickWith, hoverPoint, linkPoint } from './terminalLinks'
import { type Page, _electron as electron, expect, test } from './test'

async function listen(
  onRequest: (url: string) => void,
): Promise<{ port: number; close: () => void }> {
  const server = createServer((req, res) => {
    onRequest(req.url ?? '')
    res.setHeader('content-type', 'text/html')
    res.end('<title>Ostia link page</title><h1>hello</h1>')
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  return { port: (server.address() as AddressInfo).port, close: () => server.close() }
}

const addresses = (win: Page) => win.locator('.browser-address')
const shownAddress = (win: Page) => win.locator('.pane-slot:not([data-hidden]) .browser-address')

test('a hyperlink in a mouse-reporting program leaves plain clicks to the program and opens on Ctrl', async () => {
  test.setTimeout(60_000)
  const requests: string[] = []
  const server = await listen((url) => requests.push(url))
  const dataHome = freshDataHome()
  const reports = join(dataHome, 'mouse-reports')
  writeFileSync(reports, '')
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.locator('.xterm').first().click()
    const url = `http://127.0.0.1:${server.port}/osc`
    await win.keyboard.type(
      `clear; printf '\\033[?1000h\\033[?1006h\\033]8;;${url}\\033\\\\docs page\\033]8;;\\033\\\\\\n'; stty raw -echo; cat > ${reports}`,
    )
    await win.keyboard.press('Enter')

    const target = await linkPoint(win, /^docs\s+page\s*$/, 'page')
    await clickWith(win, target, [])
    await expect.poll(() => readFileSync(reports, 'utf8'), { timeout: 10_000 }).toMatch(/\[<\d+;/)
    expect(readFileSync(reports, 'utf8').match(/\[<\d+;\d+;\d+M/g)).toHaveLength(1)
    await expect(addresses(win)).toHaveCount(0)

    await clickWith(win, target, ['Control'])
    await expect(shownAddress(win)).toHaveValue(url, { timeout: 15_000 })
    await expect.poll(() => requests, { timeout: 15_000 }).toContain('/osc')
    expect(readFileSync(reports, 'utf8').match(/\[<\d+;\d+;\d+M/g)).toHaveLength(1)
  } finally {
    await app.close()
    server.close()
  }
})

test('links of any other scheme open in their app on a plain click and show their target', async () => {
  test.setTimeout(60_000)
  const app = await electron.launch(isolatedLaunch(freshDataHome()))
  try {
    await stubExternalOpener(app)
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.locator('.xterm').first().click()
    await win.keyboard.type(`clear; printf 'slack://channel?id=1\\nzed://file/tmp/a\\n'`)
    await win.keyboard.press('Enter')

    const hint = win.locator('[data-slot="tooltip-content"]')
    const slack = await linkPoint(win, /^slack:\/\/channel\?id=1\s*$/, 'channel')
    await hoverPoint(win, slack)
    await expect(hint).toContainText('slack://channel?id=1', { timeout: 5_000 })
    await clickWith(win, slack, [])
    const zed = await linkPoint(win, /^zed:\/\/file\/tmp\/a\s*$/, 'file')
    await hoverPoint(win, zed)
    await expect(hint).toContainText('zed://file/tmp/a', { timeout: 5_000 })
    await clickWith(win, zed, [])

    await expect
      .poll(() => openedExternally(app), { timeout: 10_000 })
      .toEqual(['slack://channel?id=1', 'zed://file/tmp/a'])
    await expect(addresses(win)).toHaveCount(0)
  } finally {
    await app.close()
  }
})
