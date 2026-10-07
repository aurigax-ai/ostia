import { type Page, _electron as electron, expect, test } from './test'
import { SOFTWARE_WEBGL, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { emptyState, emptyWorkspace } from './helpers'
import { redRowGaps } from './pixels'

const GHOSTTY_GPU = {
  behavior: { gpuAcceleration: true },
  terminal: { renderer: 'ghostty' },
  workspaces: { confirmQuit: false },
}
const RED_BLOCKS = "clear; printf '\\033[38;2;255;0;0m%s\\n%s\\n%s\\033[0m\\n' ███ ███ ███"

async function openGhostty(win: Page): Promise<void> {
  await emptyState(win)
    .getByRole('button', { name: /New workspace/ })
    .click()
  await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
  await expect(win.locator('.pane-tab .title').first()).toHaveText('zsh', { timeout: 15_000 })
  await win.waitForTimeout(1_500)
  await win.locator('.ghostty-screen').first().click()
}

test('with GPU acceleration on, Ghostty draws on WebGL and stacked blocks leave no gaps', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, GHOSTTY_GPU)
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, args: [SOFTWARE_WEBGL, ...launch.args] })
  try {
    const win = await app.firstWindow()
    await openGhostty(win)
    await expect(win.locator('.ghostty-host canvas')).toHaveCount(2)
    await win.keyboard.type(RED_BLOCKS)
    await win.keyboard.press('Enter')
    const host = win.locator('.ghostty-host').first()
    await expect.poll(async () => redRowGaps(await host.screenshot(), win)).toBe(0)
  } finally {
    await app.close()
  }
})

test('a Ghostty terminal whose WebGL context is lost keeps drawing on the canvas renderer', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, GHOSTTY_GPU)
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, args: [SOFTWARE_WEBGL, ...launch.args] })
  try {
    const win = await app.firstWindow()
    await openGhostty(win)
    const canvases = win.locator('.ghostty-host canvas')
    await expect(canvases).toHaveCount(2)
    await canvases.nth(1).evaluate((canvas) => {
      const gl = (canvas as HTMLCanvasElement).getContext('webgl2')
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
    })
    await expect(canvases).toHaveCount(1)
    await win.locator('.ghostty-screen').first().click()
    await win.keyboard.type(RED_BLOCKS)
    await win.keyboard.press('Enter')
    const host = win.locator('.ghostty-host').first()
    await expect.poll(async () => redRowGaps(await host.screenshot(), win)).toBe(0)
  } finally {
    await app.close()
  }
})
