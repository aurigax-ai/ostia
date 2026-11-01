import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chords } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, isolatedHome, startFakeAgent } from './fakeAgent'
import { openWorkspace, shownTerminalText, terminalTab, waitForPaletteSelection } from './helpers'
import { _electron as electron, expect, test } from './test'

const PAGE = `<!doctype html>
<html><head><title>Region fixture</title></head>
<body style="margin:0;background:#ffffff">
  <div data-testid="red" style="position:absolute;left:0;top:0;width:400px;height:300px;background:#ff0000"></div>
</body></html>`

function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

test('crop a region of a browser page and send it to an agent pane', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const pagePath = join(dataHome, 'region.html')
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
    await win.keyboard.press('Enter')
    const address = win.getByRole('textbox', { name: 'Address' })
    await expect(address).toBeVisible({ timeout: 15_000 })
    await address.fill(pageUrl)
    await address.press('Enter')

    await expect
      .poll(
        () =>
          app.evaluate(async ({ webContents }, url) => {
            const guest = webContents
              .getAllWebContents()
              .find((wc) => wc.getType() === 'webview' && wc.getURL() === url)
            return guest ? await guest.executeJavaScript('document.readyState') : null
          }, pageUrl),
        { timeout: 15_000 },
      )
      .toBe('complete')

    await win.getByRole('button', { name: 'Capture region' }).click()
    const layer = win.getByRole('application', { name: 'Region capture: drag over the page' })
    await expect(layer).toBeVisible()
    const box = await layer.boundingBox()
    if (!box) throw new Error('crop layer has no box')
    await win.mouse.move(box.x + 20, box.y + 30)
    await win.mouse.down()
    await win.mouse.move(box.x + 140, box.y + 110)
    await win.mouse.up()

    const bar = win.getByRole('toolbar', { name: 'Selection actions' })
    await expect(bar).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('.region-crop-box')).toBeVisible()
    await bar.getByRole('button', { name: 'Send to agent' }).click()
    await win.getByRole('menuitem').first().click()

    await expect(win.getByTestId('capture-chip')).toHaveText(/^Sent to /, { timeout: 15_000 })
    await terminalTab(win).click()
    const terminal = shownTerminalText(win)
    const inserted = /@(\S*capture-(\d+)\S*)\.md @(\S*capture-\2\S*)\.png/
    await expect(terminal).toContainText(inserted, { timeout: 15_000 })
    const match = ((await terminal.textContent()) ?? '').match(inserted) as RegExpMatchArray
    const imagePath = `${match[3]}.png`
    expect(match[1]).toBe(match[3])

    expect(pngSize(imagePath)).toEqual({ width: 120, height: 80 })
    const pixel = await app.evaluate(({ nativeImage }, path) => {
      const image = nativeImage.createFromPath(path)
      const { width, height } = image.getSize()
      const bitmap = image.toBitmap()
      const at = ((height >> 1) * width + (width >> 1)) * 4
      return [bitmap[at], bitmap[at + 1], bitmap[at + 2]]
    }, imagePath)
    expect(pixel).toEqual([0, 0, 255])
  } finally {
    await app.close()
  }
})
