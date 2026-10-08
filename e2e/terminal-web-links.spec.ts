import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, openedExternally, stubExternalOpener } from './helpers'
import { clickWith, linkPoint } from './terminalLinks'
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

async function backToTerminal(win: Page): Promise<void> {
  await win.locator('.pane-tab').first().click()
  await expect(win.locator('.pane-slot:not([data-hidden]) .xterm-rows').first()).toBeVisible()
}

test('a plain click opens the link in the browser pane and reuses it; Ctrl adds a tab; Ctrl+Shift goes outside', async () => {
  test.setTimeout(90_000)
  const requests: string[] = []
  const server = await listen((url) => requests.push(url))
  const dataHome = freshDataHome()
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await stubExternalOpener(app)
    await openWorkspace(win)
    await win.locator('.xterm').first().click()
    const base = `http://127.0.0.1:${server.port}`
    await win.keyboard.type(`clear; printf 'one ${base}/first\\ntwo ${base}/second\\n'`)
    await win.keyboard.press('Enter')

    const first = await linkPoint(win, /^one http:\/\/127\.0\.0\.1:\d+\/first\s*$/, '/first')
    await win.mouse.move(first.x, first.y + 60)
    await win.mouse.move(first.x, first.y, { steps: 6 })
    const hint = win.locator('[data-slot="tooltip-content"]')
    await expect(hint).toContainText('Click Open in the browser pane', { timeout: 5_000 })
    await expect(hint).toContainText('Ctrl+Click Open in a new browser tab')
    await expect(hint).toContainText('Ctrl+Shift+Click Open in the system browser')

    await clickWith(win, first, [])
    await expect(shownAddress(win)).toHaveValue(`${base}/first`, { timeout: 15_000 })
    await expect.poll(() => requests, { timeout: 15_000 }).toContain('/first')
    await expect(addresses(win)).toHaveCount(1)

    await backToTerminal(win)
    const second = await linkPoint(win, /^two http:\/\/127\.0\.0\.1:\d+\/second\s*$/, '/second')
    await clickWith(win, second, [])
    await expect(shownAddress(win)).toHaveValue(`${base}/second`, { timeout: 15_000 })
    await expect.poll(() => requests, { timeout: 15_000 }).toContain('/second')
    await expect(addresses(win)).toHaveCount(1)

    await backToTerminal(win)
    await clickWith(
      win,
      await linkPoint(win, /^one http:\/\/127\.0\.0\.1:\d+\/first\s*$/, '/first'),
      ['Control'],
    )
    await expect(shownAddress(win)).toHaveValue(`${base}/first`, { timeout: 15_000 })
    await expect(addresses(win)).toHaveCount(2)

    await backToTerminal(win)
    await clickWith(
      win,
      await linkPoint(win, /^two http:\/\/127\.0\.0\.1:\d+\/second\s*$/, '/second'),
      ['Control', 'Shift'],
    )
    await expect.poll(() => openedExternally(app), { timeout: 15_000 }).toEqual([`${base}/second`])
    await expect(addresses(win)).toHaveCount(2)
    await expect(win.locator('.pane-slot:not([data-hidden]) .xterm-rows').first()).toBeVisible()
  } finally {
    await app.close()
    server.close()
  }
})

test('a plain click on a link never opens while a drag selected text', async () => {
  test.setTimeout(60_000)
  const server = await listen(() => {})
  const dataHome = freshDataHome()
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.locator('.xterm').first().click()
    const url = `http://127.0.0.1:${server.port}/drag`
    await win.keyboard.type(`clear; printf 'see ${url}\\n'`)
    await win.keyboard.press('Enter')
    const point = await linkPoint(win, /^see http:\/\/127\.0\.0\.1:\d+\/drag\s*$/, '/drag')
    await win.mouse.move(point.x - 40, point.y)
    await win.mouse.down()
    await win.mouse.move(point.x, point.y, { steps: 8 })
    await win.mouse.up()
    await expect(win.locator('.xterm-selection div').first()).toBeAttached()
    await win.waitForTimeout(500)
    await expect(addresses(win)).toHaveCount(0)
  } finally {
    await app.close()
    server.close()
  }
})

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
    await win.mouse.move(target.x, target.y + 60)
    await win.mouse.move(target.x, target.y, { steps: 6 })
    const hint = win.locator('[data-slot="tooltip-content"]')
    await expect(hint).toContainText('Ctrl+Click Open in a new browser tab', { timeout: 5_000 })
    await expect(hint).not.toContainText('Open in the browser pane')

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
