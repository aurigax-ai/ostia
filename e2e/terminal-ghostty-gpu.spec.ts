import { SOFTWARE_WEBGL } from './dataHome'
import { launchGhostty } from './ghostty'
import { addTab, typeLine } from './helpers'
import { RED_BLOCKS, redRowGaps } from './pixels'
import { expect, test } from './test'

const launchOnGpu = () => launchGhostty({ behavior: { gpuAcceleration: true } }, [SOFTWARE_WEBGL])

test('with GPU acceleration on, Ghostty draws on WebGL and stacked blocks leave no gaps', async () => {
  const { app, win } = await launchOnGpu()
  try {
    await expect(win.locator('.ghostty-host canvas')).toHaveCount(2)
    await typeLine(win, RED_BLOCKS)
    const host = win.locator('.ghostty-host').first()
    await expect.poll(async () => redRowGaps(await host.screenshot(), win)).toBe(0)
  } finally {
    await app.close()
  }
})

test('a Ghostty terminal whose WebGL context is lost keeps drawing on the canvas renderer', async () => {
  const { app, win } = await launchOnGpu()
  try {
    const canvases = win.locator('.ghostty-host canvas')
    await expect(canvases).toHaveCount(2)
    await canvases.nth(1).evaluate((canvas) => {
      const gl = (canvas as HTMLCanvasElement).getContext('webgl2')
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
    })
    await expect(canvases).toHaveCount(1)
    await win.locator('.ghostty-screen').first().click()
    await typeLine(win, RED_BLOCKS)
    const host = win.locator('.ghostty-host').first()
    await expect.poll(async () => redRowGaps(await host.screenshot(), win)).toBe(0)
  } finally {
    await app.close()
  }
})

test('a Ghostty terminal hidden in a background tab gives up its WebGL renderer and shows what it printed when revealed', async () => {
  test.setTimeout(60_000)
  const { app, win } = await launchOnGpu()
  try {
    const first = win.locator('.ghostty-host').first()
    await expect(first.locator('canvas')).toHaveCount(2)
    await typeLine(win, `sleep 2; ${RED_BLOCKS}`)

    await addTab(win)
    const tabs = win.getByRole('tablist').getByRole('tab')
    await expect(tabs).toHaveCount(2, { timeout: 15_000 })
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')

    await expect(first.locator('canvas')).toHaveCount(1, { timeout: 20_000 })

    await tabs.nth(0).click()
    await expect(first.locator('canvas')).toHaveCount(2)
    await expect.poll(async () => redRowGaps(await first.screenshot(), win)).toBe(0)
  } finally {
    await app.close()
  }
})

test('Ghostty on the GPU keeps drawing glyphs from before its atlas grew', async () => {
  test.setTimeout(90_000)
  const { app, win } = await launchOnGpu()
  try {
    await expect(win.locator('.ghostty-host canvas')).toHaveCount(2)
    const host = win.locator('.ghostty-host').first()
    await typeLine(win, RED_BLOCKS)
    await expect.poll(async () => redRowGaps(await host.screenshot(), win)).toBe(0)
    await typeLine(
      win,
      'clear; for i in {19968..21500}; do printf "\\\\U$(printf %x $i)"; done; echo',
    )
    await typeLine(win, RED_BLOCKS)
    await expect
      .poll(async () => redRowGaps(await host.screenshot(), win), { timeout: 30_000 })
      .toBe(0)
  } finally {
    await app.close()
  }
})
