import { _electron as electron, expect, test } from '@playwright/test'
import { SOFTWARE_WEBGL, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { emptyState, emptyWorkspace } from './helpers'

async function redRowGaps(png: Buffer, page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return -1
    ctx.drawImage(img, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height)
    const isRed = (x: number, y: number): boolean => {
      const i = (y * width + x) * 4
      return data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60
    }
    let column = -1
    for (let x = 0; x < width && column < 0; x++) {
      for (let y = 0; y < height; y++) {
        if (isRed(x, y)) {
          column = x + 4
          break
        }
      }
    }
    if (column < 0) return -1
    const rows: number[] = []
    for (let y = 0; y < height; y++) if (isRed(column, y)) rows.push(y)
    let gaps = 0
    for (let i = 1; i < rows.length; i++) if (rows[i] - rows[i - 1] > 1) gaps++
    return gaps
  }, png.toString('base64'))
}

test('the GPU renderer draws stacked block characters without gaps between rows', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, { behavior: { gpuAcceleration: true } })
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, args: [SOFTWARE_WEBGL, ...launch.args] })
  try {
    const win = await app.firstWindow()
    await emptyState(win)
      .getByRole('button', { name: /New workspace/ })
      .click()
    await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
    const screen = win.locator('.xterm-screen').first()
    await expect(screen.locator('canvas').first()).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('.xterm-rows')).toHaveCount(0)
    await win.waitForTimeout(1_500)
    await win.locator('.xterm').first().click()
    await win.keyboard.type(
      "clear; printf '\\033[38;2;255;0;0m%s\\n%s\\n%s\\033[0m\\n' ███ ███ ███",
    )
    await win.keyboard.press('Enter')
    await expect.poll(async () => redRowGaps(await screen.screenshot(), win)).toBe(0)
  } finally {
    await app.close()
  }
})
