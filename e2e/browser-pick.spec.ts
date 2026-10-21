import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chords } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, isolatedHome, startFakeAgent } from './fakeAgent'
import { openWorkspace, shownTerminal, terminalTab, waitForPaletteSelection } from './helpers'
import { _electron as electron, expect, test } from './test'

const PAGE = `<!doctype html>
<html><head><title>Pick fixture</title></head>
<body style="margin:0">
  <p>filler</p>
  <button data-testid="broken-button" style="margin:40px;width:160px;height:40px">Checkout</button>
  <script>console.error('checkout exploded')</script>
</body></html>`

test('pick an element in a browser pane and send it to a terminal pane', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const pagePath = join(dataHome, 'pick.html')
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

    await win.keyboard.press(chords.palette)
    await win.locator('[data-slot="command-input"]').fill('Open Browser')
    await waitForPaletteSelection(win, 'Open Browser')
    await expect(win.getByRole('dialog').getByText('Open Browser', { exact: true })).toBeVisible()
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

    await expect
      .poll(() => guestEval<boolean>('!!document.querySelector("[data-testid=broken-button]")'), {
        timeout: 15_000,
      })
      .toBe(true)

    const pick = win.getByRole('button', { name: 'Point at element' })
    await pick.click()
    await expect(win.getByRole('button', { name: 'Stop pointing' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect
      .poll(() => guestEval<boolean>('!!document.querySelector("[data-ostia-pick]")'))
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

    const bar = win.getByRole('toolbar', { name: 'Selection actions' })
    await expect(bar).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(() => guestEval<boolean>('!!document.querySelector("[data-ostia-pick]")'))
      .toBe(false)

    await bar.getByRole('button', { name: 'Add a note' }).click()
    await win.getByRole('textbox', { name: 'Add a note' }).fill('Checkout button is misaligned')
    await bar.getByRole('button', { name: 'Send to agent' }).click()
    await expect(win.getByRole('menuitem')).toHaveCount(1)
    await win.getByRole('menuitem').click()

    await expect(win.getByText(/The report is at its prompt/)).toBeVisible({ timeout: 15_000 })
    await terminalTab(win).click()
    const terminal = shownTerminal(win).locator('.xterm-rows')
    await expect(terminal).toContainText(/@\S*capture-\d+\S*\.md @\S*pick-\S*\.png/, {
      timeout: 15_000,
    })
    const text = (await terminal.textContent()) ?? ''
    const match = text.match(/@(\S*capture-\d+\S*\.md)/)
    expect(match).not.toBeNull()
    const report = readFileSync((match as RegExpMatchArray)[1], 'utf8')
    expect(report).toContain('[data-testid="broken-button"]')
    expect(report).toContain('Checkout button is misaligned')
    expect(report).toContain('checkout exploded')
    expect(report).toMatch(/- Screenshot: \S+\.png/)
    const shot = text.match(/capture-\d+\S*\.md @(\S*pick-\S*\.png)/)
    expect(shot).not.toBeNull()
    expect(report).toContain(`![Captured element](${(shot as RegExpMatchArray)[1]})`)
  } finally {
    await app.close()
  }
})
