import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, isolatedHome, startFakeAgent } from './fakeAgent'
import { openWorkspace, waitForPaletteSelection } from './helpers'

const PAGE = `<!doctype html>
<html><head><title>Detached fixture</title></head>
<body style="margin:0">
  <p>filler</p>
  <button data-testid="broken-button" style="margin:40px;width:160px;height:40px">Checkout</button>
</body></html>`

test('a browser pane moved to its own window sends a picked element to the agent it left behind', async () => {
  test.setTimeout(150_000)
  const dataHome = freshDataHome()
  const pagePath = join(dataHome, 'detached.html')
  writeFileSync(pagePath, PAGE)
  const pageUrl = pathToFileURL(pagePath).href

  const bin = fakeAgentBin(dataHome)
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, HOME: isolatedHome(dataHome), PATH: `${bin}:${launch.env.PATH}` },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await startFakeAgent(win)

    await win.keyboard.press('Control+Shift+P')
    await win.locator('[data-slot="command-input"]').fill('Open Browser')
    await waitForPaletteSelection(win, 'Open Browser')
    await win.keyboard.press('Enter')
    const address = win.getByRole('textbox', { name: 'Address' })
    await expect(address).toBeVisible({ timeout: 15_000 })
    await address.fill(pageUrl)
    await address.press('Enter')

    const guestEval = <T>(js: string): Promise<T> =>
      app.evaluate(
        async ({ webContents }, { url, code }) => {
          const guest = webContents
            .getAllWebContents()
            .find((wc) => wc.getType() === 'webview' && wc.getURL() === url)
          return guest ? await guest.executeJavaScript(code) : null
        },
        { url: pageUrl, code: js },
      ) as Promise<T>
    const buttonReady = (): Promise<boolean> =>
      guestEval<boolean>('!!document.querySelector("[data-testid=broken-button]")')
    await expect.poll(buttonReady, { timeout: 15_000 }).toBe(true)

    await win.locator('.pane-tab:visible').last().click({ button: 'right' })
    const [detached] = await Promise.all([
      app.waitForEvent('window'),
      win.getByRole('menuitem', { name: 'Move pane to new window' }).click(),
    ])
    await detached.waitForLoadState('domcontentloaded')
    await expect(detached.getByRole('textbox', { name: 'Address' })).toBeVisible({
      timeout: 15_000,
    })
    await expect(win.getByRole('textbox', { name: 'Address' })).toHaveCount(0)
    await expect(detached.locator('.xterm')).toHaveCount(0)
    await expect.poll(buttonReady, { timeout: 15_000 }).toBe(true)

    await detached.getByRole('button', { name: 'Point at element' }).click()
    await expect
      .poll(() => guestEval<boolean>('!!document.querySelector("[data-pine-pick]")'), {
        timeout: 15_000,
      })
      .toBe(true)
    const box = await guestEval<{ x: number; y: number }>(
      '(() => { const r = document.querySelector("[data-testid=broken-button]").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()',
    )
    await app.evaluate(
      ({ webContents }, { url, x, y }) => {
        const guest = webContents
          .getAllWebContents()
          .find((wc) => wc.getType() === 'webview' && wc.getURL() === url)
        if (!guest) throw new Error('guest missing')
        guest.sendInputEvent({ type: 'mouseMove', x, y })
        guest.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        guest.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      },
      { url: pageUrl, x: box.x, y: box.y },
    )

    const panel = detached.getByRole('region', { name: 'Send to agent' })
    await expect(panel).toBeVisible({ timeout: 15_000 })
    await expect(panel.getByRole('radio')).toHaveCount(1, { timeout: 15_000 })
    await expect(panel).toContainText('other window')
    await expect(panel).not.toContainText('No agent is running')
    await panel.getByLabel('What’s wrong?').fill('Checkout button is misaligned')
    await panel.getByRole('button', { name: 'Send' }).click()

    await expect(detached.getByText(/The report is at its prompt/)).toBeVisible({
      timeout: 15_000,
    })
    const terminal = win.locator('.xterm-rows').first()
    await expect(terminal).toContainText(/@\S*capture-\d+\S*\.md/, { timeout: 15_000 })
    await win.waitForTimeout(500)
    const text = (await terminal.textContent()) ?? ''
    expect(text.match(/capture-\d+\S*\.md/g)).toHaveLength(1)
    const match = text.match(/@(\S*capture-\d+\S*\.md)/)
    const report = readFileSync((match as RegExpMatchArray)[1], 'utf8')
    expect(report).toContain('[data-testid="broken-button"]')
    expect(report).toContain('Checkout button is misaligned')
  } finally {
    await app.close()
  }
})
