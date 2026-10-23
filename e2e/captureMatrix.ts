import { chords, defaultChord, isMac } from './chords'
import { expectHeld } from './helpers'
import { type ElectronApplication, expect, type Page, test } from './test'

export const sendToAgent = defaultChord('selection.sendToAgent', isMac)
export const plainCopy = isMac ? 'Meta+c' : 'Control+c'

export const readClipboard = (app: ElectronApplication) =>
  app.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read()
    const plain = items.find((item) => item.types.includes('text/plain'))
    return {
      text: plain ? await (await plain.getType('text/plain')).text() : '',
      hasImage: items.some((item) => item.types.some((type) => type.startsWith('image/'))),
    }
  })

interface LaunchedSurface {
  app: ElectronApplication
  win: Page
  open: () => Promise<void>
  status: RegExp | string
  copied: RegExp
  cleared: () => Promise<void>
  close: () => Promise<void>
}

export interface CaptureSurface {
  name: string
  launch: () => Promise<LaunchedSurface>
}

export async function runCaptureMatrix(surface: CaptureSurface): Promise<void> {
  const { app, win, open, status, copied, cleared, close } = await surface.launch()
  try {
    const bar = win.getByRole('toolbar', { name: 'Selection actions' })
    const line = win.getByText(status)
    const shown = async (): Promise<void> => {
      await open()
      await expect(bar).toBeVisible({ timeout: 15_000 })
    }
    const marker = (): Promise<void> =>
      app.evaluate(({ clipboard }) => clipboard.writeText('marker'))

    await test.step('opens the bar at the selection', shown)

    await test.step('Escape closes the bar and clears what it drew', async () => {
      await win.keyboard.press('Escape')
      await expect(bar).toBeHidden()
      await cleared()
    })

    await test.step('a click elsewhere in the window closes the bar and clears what it drew', async () => {
      await shown()
      await win.locator('.topbar').click({ position: { x: 4, y: 4 } })
      await expect(bar).toBeHidden()
      await cleared()
    })

    await test.step('the Copy button copies, closes the bar and shows the pane status', async () => {
      await shown()
      await marker()
      await bar.getByRole('button', { name: 'Copy' }).click()
      await expect(line).toBeVisible()
      await expect(bar).toBeHidden()
      expect((await readClipboard(app)).text).toMatch(copied)
      await cleared()
    })

    await test.step('the copy chord does the same as the button', async () => {
      await shown()
      await marker()
      await win.keyboard.press(plainCopy)
      await expect(line).toBeVisible()
      await expect(bar).toBeHidden()
      expect((await readClipboard(app)).text).toMatch(copied)
      await cleared()
    })

    await test.step('the send chord with a bar open opens its Send menu', async () => {
      await shown()
      await win.keyboard.press(sendToAgent)
      await expect(win.getByRole('menu')).toBeVisible()
      await expect
        .poll(() => win.evaluate(() => document.activeElement?.closest('[role="menu"]') !== null))
        .toBe(true)
      await expect(bar).toBeVisible()
      await win.keyboard.press('Escape')
      await expect(win.getByRole('menu')).toBeHidden()
      await expect(bar).toBeVisible()
    })

    await test.step('the window losing focus never closes the bar', async () => {
      await win.evaluate(() => window.dispatchEvent(new Event('blur')))
      await expectHeld(() => bar.isVisible(), true, 800, 'the bar stays open')
    })

    await test.step('hiding the pane closes the bar and clears what it drew', async () => {
      await win.keyboard.press(chords.newTab)
      await expect(bar).toBeHidden()
      await cleared()
    })
  } finally {
    await close()
  }
}
