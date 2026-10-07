import { SOFTWARE_WEBGL, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { emptyState, emptyWorkspace } from './helpers'
import { redRowGaps } from './pixels'
import { type Page, _electron as electron, expect, test } from './test'

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
  const app = await electron.launch({
    ...launch,
    args: [SOFTWARE_WEBGL, ...launch.args],
    env: { ...launch.env, SHELL: '/bin/zsh' },
  })
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
  const app = await electron.launch({
    ...launch,
    args: [SOFTWARE_WEBGL, ...launch.args],
    env: { ...launch.env, SHELL: '/bin/zsh' },
  })
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

test('a Ghostty terminal hidden in a background tab gives up its WebGL renderer and shows what it printed when revealed', async () => {
  test.setTimeout(60_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, GHOSTTY_GPU)
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    args: [SOFTWARE_WEBGL, ...launch.args],
    env: { ...launch.env, SHELL: '/bin/zsh' },
  })
  try {
    const win = await app.firstWindow()
    await openGhostty(win)
    const first = win.locator('.ghostty-host').first()
    await expect(first.locator('canvas')).toHaveCount(2)
    await win.keyboard.type(`sleep 2; ${RED_BLOCKS}`)
    await win.keyboard.press('Enter')

    const strip = win.getByRole('tablist')
    const box = await strip.boundingBox()
    const lastTab = await strip.locator('.pane-tab').last().boundingBox()
    if (!lastTab || !box) throw new Error('tab strip is not laid out')
    await win.mouse.dblclick(lastTab.x + lastTab.width + 40, box.y + box.height / 2)
    const tabs = strip.getByRole('tab')
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
