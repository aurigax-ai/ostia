import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CaptureSurface } from './captureMatrix'
import { chords } from './chords'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { guestKeys, pressInPage } from './guestKeys'
import { launchWindow, openWorkspace, runInTerminal, waitForPaletteSelection } from './helpers'
import { _electron as electron, expect, type Page } from './test'

const PAGE = `<!doctype html>
<html><head><title>Capture fixture</title></head>
<body style="margin:0">
  <p id="note" style="margin:16px">Refund pending for order 4823</p>
  <table id="orders" style="margin:16px;border-collapse:collapse">
    <thead><tr><th>Order</th><th colspan="2">Customer</th></tr></thead>
    <tbody>
      <tr><td data-testid="first-cell">#4821</td><td>Northwind, Ltd</td><td>EU</td></tr>
      <tr><td>#4822</td><td>Fabrikam "Home"</td><td>US</td></tr>
    </tbody>
  </table>
  <div id="swatch" style="margin:16px;width:120px;height:60px;background:#ff0000"></div>
</body></html>`

const PREVIEW_PAGE = `<!doctype html><title>preview</title>
<body style="margin:0">
  <p id="note" style="margin:40px;font:24px sans-serif">Selectable preview words</p>
  <table id="orders" style="margin:0 40px;border-collapse:collapse;font:18px sans-serif">
    <thead><tr><th>Order</th><th>Customer</th></tr></thead>
    <tbody><tr><td id="cell">#4821</td><td>Northwind</td></tr><tr><td>#4822</td><td>Fabrikam</td></tr></tbody>
  </table>
</body>`

const OUTLINE = { selector: '.browser-stage .region-crop-box', sized: false }
const CROP = { selector: '.browser-stage .region-crop-box', sized: true }

type Gesture = 'pick-image' | 'pick-table' | 'page-text' | 'region'

async function pointAt(
  win: Page,
  guest: (js: string) => Promise<unknown>,
  inGuest: (input: { x: number; y: number }) => Promise<void>,
  selector: string,
): Promise<void> {
  await win.getByRole('button', { name: 'Point at element' }).click()
  await expect.poll(() => guest('!!document.querySelector("[data-ostia-pick]")')).toBe(true)
  const at = (await guest(
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`,
  )) as { x: number; y: number }
  await inGuest(at)
}

function browserSurface(name: string, gesture: Gesture): CaptureSurface {
  return {
    name,
    launch: async () => {
      const dataHome = freshDataHome()
      const pagePath = join(dataHome, 'capture.html')
      writeFileSync(pagePath, PAGE)
      const pageUrl = pathToFileURL(pagePath).href
      const app = await electron.launch(isolatedLaunch(dataHome))
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await openWorkspace(win)
      await win.keyboard.press(chords.palette)
      await win.locator('[data-slot="command-input"]').fill('Open Browser')
      await waitForPaletteSelection(win, 'Open Browser')
      await win.keyboard.press('Enter')
      const address = win.getByRole('textbox', { name: 'Address' })
      await expect(address).toBeVisible({ timeout: 15_000 })
      await address.fill(pageUrl)
      await address.press('Enter')
      const guest = (js: string): Promise<unknown> =>
        app.evaluate(
          async ({ webContents }, { url, code }) => {
            const found = webContents
              .getAllWebContents()
              .find((wc) => wc.getType() === 'webview' && wc.getURL() === url)
            return found ? await found.executeJavaScript(code) : null
          },
          { url: pageUrl, code: js },
        )
      await expect
        .poll(() => guest('!!document.getElementById("orders")'), { timeout: 15_000 })
        .toBe(true)
      const click = (at: { x: number; y: number }): Promise<void> =>
        app.evaluate(
          ({ webContents }, { url, x, y }) => {
            const found = webContents
              .getAllWebContents()
              .find((wc) => wc.getType() === 'webview' && wc.getURL() === url)
            if (!found) throw new Error('guest missing')
            found.sendInputEvent({ type: 'mouseMove', x, y })
            found.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
            found.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
          },
          { url: pageUrl, ...at },
        )
      const stage = win.locator('.browser-stage')
      const open = async (): Promise<void> => {
        if (gesture === 'pick-image') {
          await pointAt(win, guest, click, '#swatch')
        } else if (gesture === 'pick-table') {
          await pointAt(win, guest, click, '[data-testid=first-cell]')
        } else if (gesture === 'page-text') {
          await guest('window.getSelection().selectAllChildren(document.getElementById("note"))')
          await pressInPage(app, guestKeys.sendToAgent)
        } else {
          await win.getByRole('button', { name: 'Capture region' }).click()
          const box = await stage.boundingBox()
          if (!box) throw new Error('browser stage has no box')
          await win.mouse.move(box.x + 40, box.y + 40)
          await win.mouse.down()
          await win.mouse.move(box.x + 200, box.y + 120, { steps: 6 })
          await win.mouse.up()
        }
      }
      return {
        app,
        win,
        open,
        status:
          gesture === 'pick-table'
            ? /^Copied the table/
            : gesture === 'page-text'
              ? 'Copied the selection.'
              : /^Copied the (element screenshot|image)/,
        copied:
          gesture === 'pick-table'
            ? /^Order,Customer,Customer\n#4821,"Northwind, Ltd",EU\n#4822,"Fabrikam ""Home""",US$/
            : gesture === 'page-text'
              ? /^Refund pending for order 4823$/
              : 'image',
        highlight: gesture === 'region' ? CROP : gesture === 'page-text' ? undefined : OUTLINE,
        cleared: async () => {
          await expect(win.locator('.browser-stage .region-crop-box')).toHaveCount(0)
        },
        clickGuest: async () => {
          const box = await win.locator('webview:visible').boundingBox()
          if (!box) throw new Error('browser page has no box')
          await win.mouse.click(box.x + box.width - 40, box.y + box.height - 40)
        },
        close: () => app.close(),
      }
    },
  }
}

export const browserPickSurface = browserSurface('browser-pick', 'pick-image')
export const browserTableSurface = browserSurface('browser-table', 'pick-table')
export const browserTextSurface = browserSurface('browser-text', 'page-text')
export const browserRegionSurface = browserSurface('browser-region', 'region')

function previewSurface(name: string, gesture: 'pick-table' | 'region'): CaptureSurface {
  return {
    name,
    launch: async () => {
      const dataHome = freshDataHome()
      const home = join(dataHome, 'home')
      mkdirSync(home, { recursive: true })
      writeFileSync(join(home, 'page.html'), PREVIEW_PAGE)
      seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, editor: { openFilesIn: 'split' } })
      const { app, win } = await launchWindow(dataHome)
      await openWorkspace(win)
      await runInTerminal(win, 'ostia open ~/page.html')
      await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 20_000 })
      await win.getByRole('button', { name: 'Run page in preview' }).click()
      const frame = win.locator('.preview-frame')
      await expect(frame).toBeVisible({ timeout: 20_000 })
      const guest = (js: string): Promise<unknown> =>
        app.evaluate(async ({ webContents }, code) => {
          const found = webContents
            .getAllWebContents()
            .find((wc) => wc.getURL().startsWith('ostia-preview://'))
          return found ? await found.executeJavaScript(code) : null
        }, js)
      await expect
        .poll(() => guest('document.body.innerText'), { timeout: 20_000 })
        .toContain('Selectable preview words')
      expect(
        await app.evaluate(({ webContents }) => {
          const found = webContents
            .getAllWebContents()
            .find((wc) => wc.getURL().startsWith('ostia-preview://'))
          return found ? found.mainFrame.frames.length : -1
        }),
      ).toBe(0)
      expect(await guest('window.origin')).toBe('null')
      const click = (at: { x: number; y: number }): Promise<void> =>
        app.evaluate(({ webContents }, { x, y }) => {
          const found = webContents
            .getAllWebContents()
            .find((wc) => wc.getURL().startsWith('ostia-preview://'))
          if (!found) throw new Error('no preview guest')
          found.sendInputEvent({ type: 'mouseMove', x, y })
          found.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
          found.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
        }, at)
      const open = async (): Promise<void> => {
        if (gesture === 'pick-table') {
          await pointAt(win, guest, click, '#cell')
          return
        }
        await win.getByRole('button', { name: 'Capture region' }).click()
        const box = await frame.boundingBox()
        if (!box) throw new Error('preview frame has no box')
        await win.mouse.move(box.x + 40, box.y + 40)
        await win.mouse.down()
        await win.mouse.move(box.x + 260, box.y + 120, { steps: 6 })
        await win.mouse.up()
      }
      return {
        app,
        win,
        open,
        status: gesture === 'pick-table' ? /^Copied the table/ : /^Copied the image/,
        copied:
          gesture === 'pick-table' ? /^Order,Customer\n#4821,Northwind\n#4822,Fabrikam$/ : 'image',
        highlight: {
          selector: '.preview-frame .region-crop-box',
          sized: gesture === 'region',
        },
        cleared: async () => {
          await expect(win.locator('.preview-frame .region-crop-box')).toHaveCount(0)
        },
        clickGuest: async () => {
          const box = await frame.boundingBox()
          if (!box) throw new Error('preview frame has no box')
          await win.mouse.click(box.x + box.width - 40, box.y + box.height - 40)
        },
        close: () => app.close(),
      }
    },
  }
}

export const previewPickSurface = previewSurface('preview-pick', 'pick-table')
export const previewRegionSurface = previewSurface('preview-region', 'region')
