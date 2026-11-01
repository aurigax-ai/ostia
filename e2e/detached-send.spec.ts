import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chords } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, isolatedHome, REPORT_SESSION, startFakeAgent } from './fakeAgent'
import { expectHeld, openWorkspace, waitForPaletteSelection } from './helpers'
import { _electron as electron, expect, test } from './test'

const PAGE = `<!doctype html>
<html><head><title>Detached fixture</title></head>
<body style="margin:0">
  <p>filler</p>
  <button data-testid="broken-button" style="margin:40px;width:160px;height:40px">Checkout</button>
</body></html>`

const LINE_AGENT = `#!/bin/sh\n${REPORT_SESSION}\necho fake-agent-ready\nwhile IFS= read -r line; do echo "agent-read: $line"; done\n`

test('a browser pane moved to its own window sends a picked element to the agent it left behind', async () => {
  test.setTimeout(150_000)
  const dataHome = freshDataHome()
  const pagePath = join(dataHome, 'detached.html')
  writeFileSync(pagePath, PAGE)
  const pageUrl = pathToFileURL(pagePath).href

  const bin = fakeAgentBin(dataHome, LINE_AGENT)
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
      win.getByRole('menuitem', { name: 'Move to new window' }).click(),
    ])
    await detached.waitForLoadState('domcontentloaded')
    await expect(detached.getByRole('textbox', { name: 'Address' })).toBeVisible({
      timeout: 15_000,
    })
    await expect(win.getByRole('textbox', { name: 'Address' })).toHaveCount(0)
    await expect(detached.locator('.ghostty-host')).toHaveCount(0)
    await expect.poll(buttonReady, { timeout: 15_000 }).toBe(true)

    await detached.getByRole('button', { name: 'Point at element' }).click()
    await expect
      .poll(() => guestEval<boolean>('!!document.querySelector("[data-ostia-pick]")'), {
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

    const bar = detached.getByRole('toolbar', { name: 'Selection actions' })
    await expect(bar).toBeVisible({ timeout: 15_000 })
    await bar.getByRole('button', { name: 'Add a note' }).click()
    await detached
      .getByRole('textbox', { name: 'Add a note' })
      .fill('Checkout button is misaligned')
    await bar.getByRole('button', { name: 'Send to agent' }).click()
    const targets = detached.getByRole('menuitem')
    await expect(targets).toHaveCount(1, { timeout: 15_000 })
    await expect(targets).toContainText('other window')
    await targets.click()

    await expect(detached.getByTestId('capture-chip')).toHaveText(/^Sent to /, {
      timeout: 15_000,
    })
    const terminal = win.locator('.terminal-text').first()
    await expect(terminal).toContainText(/Checkout button is misaligned @\S*capture-\d+\S*\.md/, {
      timeout: 15_000,
    })
    await expect(terminal).not.toContainText('agent-read:')
    await win.locator('.ghostty-host').first().click()
    await win.keyboard.press('Enter')
    await expect(terminal).toContainText(/agent-read: [^@]*@\S*capture-\d+\S*\.md/, {
      timeout: 15_000,
    })
    const reports = async (): Promise<{ lines: number; files: number }> => {
      const text = (await terminal.textContent()) ?? ''
      return {
        lines: text.match(/agent-read: [^@]*@\S*capture-\d+\S*\.md/g)?.length ?? 0,
        files: new Set(text.match(/capture-\d+\S*\.md/g)).size,
      }
    }
    await expectHeld(reports, { lines: 1, files: 1 }, 2_000)
    const text = (await terminal.textContent()) ?? ''
    const match = text.match(/agent-read: [^@]*@(\S*capture-\d+\S*\.md)/)
    const report = readFileSync((match as RegExpMatchArray)[1], 'utf8')
    expect(report).toContain('[data-testid="broken-button"]')
    expect(report).toContain('Checkout button is misaligned')
  } finally {
    await app.close()
  }
})
