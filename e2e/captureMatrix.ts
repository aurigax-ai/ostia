import { chords, defaultChord, isMac } from './chords'
import { expectHeld } from './helpers'
import { type ElectronApplication, expect, type Page, test } from './test'

export const sendToAgent = defaultChord('selection.sendToAgent', isMac)
const plainCopy = isMac ? 'Meta+c' : 'Control+c'

const readClipboard = (app: ElectronApplication) =>
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
  chip: string
  copied: RegExp | 'image'
  cleared: () => Promise<void>
  close: () => Promise<void>
  highlight?: { selector: string; sized: boolean }
  clickGuest?: () => Promise<void>
  file?: { append: (rows: number, everyMs: number) => Promise<void>; editMiddleRow: () => void }
}

export interface CaptureSurface {
  name: string
  launch: () => Promise<LaunchedSurface>
}

export async function runCaptureMatrix(surface: CaptureSurface): Promise<void> {
  const {
    app,
    win,
    open,
    chip: label,
    copied,
    cleared,
    close,
    highlight,
    clickGuest,
  } = await surface.launch()
  try {
    const bar = win.getByRole('toolbar', { name: 'Selection actions' })
    const chip = win.getByTestId('capture-chip')
    const shown = async (): Promise<void> => {
      await open()
      await expect(bar).toBeVisible({ timeout: 15_000 })
    }
    const marker = (): Promise<void> =>
      app.evaluate(({ clipboard }) => clipboard.writeText('marker'))

    const expectCopied = async (): Promise<void> => {
      const clip = await readClipboard(app)
      if (copied === 'image') expect(clip.hasImage).toBe(true)
      else expect(clip.text).toMatch(copied)
    }

    await test.step('opens the bar at the selection and draws its highlight', async () => {
      await shown()
      if (!highlight) return
      const drawn = win.locator(highlight.selector)
      await expect(drawn).toBeVisible()
      await expect(drawn.locator('.region-crop-size')).toHaveCount(highlight.sized ? 1 : 0)
    })

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

    if (clickGuest) {
      await test.step('a click inside the page closes the bar and clears what it drew', async () => {
        await shown()
        await clickGuest()
        await expect(bar).toBeHidden()
        await cleared()
      })
    }

    await test.step('the Copy button copies, closes the bar and shows the chip, which fades after two seconds', async () => {
      await shown()
      await marker()
      await bar.getByRole('button', { name: 'Copy' }).click()
      await expect(chip).toHaveText(label)
      await expect(bar).toBeHidden()
      await expectCopied()
      await cleared()
      await expect(chip).toBeHidden({ timeout: 5_000 })
    })

    await test.step('the copy chord does the same as the button', async () => {
      await shown()
      await marker()
      await win.keyboard.press(plainCopy)
      await expect(chip).toHaveText(label)
      await expect(bar).toBeHidden()
      await expectCopied()
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
