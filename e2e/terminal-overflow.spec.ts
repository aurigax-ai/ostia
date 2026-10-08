import {
  DOM_RENDERER_SETTINGS,
  SOFTWARE_WEBGL,
  freshDataHome,
  isolatedLaunch,
  seedSettings,
} from './dataHome'
import { openWorkspace } from './helpers'
import { textPainted } from './pixels'
import { type Page, _electron as electron, expect, test } from './test'

interface Placement {
  pastRight: number
  pastLeft: number
  scrolled: number
}

function placement(win: Page): Promise<Placement> {
  return win.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.pane-body-term')
    const screen = document.querySelector<HTMLElement>('.xterm-screen')
    if (!body || !screen) throw new Error('no terminal')
    const bodyRect = body.getBoundingClientRect()
    const screenRect = screen.getBoundingClientRect()
    let scrolled = 0
    for (let el: HTMLElement | null = screen; el; el = el.parentElement) scrolled += el.scrollLeft
    return {
      pastRight: Math.max(0, Math.round(screenRect.right - bodyRect.right)),
      pastLeft: Math.max(0, Math.round(bodyRect.left - screenRect.left)),
      scrolled,
    }
  })
}

for (const renderer of ['WebGL', 'DOM'] as const) {
  test(`the ${renderer} terminal stays inside its pane after the pixel ratio changes and an IME composes at the right edge`, async () => {
    test.setTimeout(90_000)
    const dataHome = freshDataHome()
    const gpu = renderer === 'WebGL'
    seedSettings(dataHome, {
      ...DOM_RENDERER_SETTINGS,
      behavior: { ...DOM_RENDERER_SETTINGS.behavior, gpuAcceleration: gpu },
    })
    const launch = isolatedLaunch(dataHome)
    const app = await electron.launch(
      gpu ? { ...launch, args: [SOFTWARE_WEBGL, ...launch.args] } : launch,
    )
    try {
      const win = await app.firstWindow()
      await openWorkspace(win)
      const screen = win.locator('.xterm-screen').first()
      await win.locator('.xterm').first().click()

      const cdp = await win.context().newCDPSession(win)
      for (const scale of [1.5, 2, 1.25]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: 0,
          height: 0,
          deviceScaleFactor: scale,
          mobile: false,
        })
        await expect.poll(() => win.evaluate(() => window.devicePixelRatio)).toBe(scale)
        await win.keyboard.type("printf '\\033[?1049h\\033[999C'; read -s")
        await win.keyboard.press('Enter')
        await expect.poll(async () => textPainted(await screen.screenshot(), win)).toBe(false)
        await cdp.send('Input.imeSetComposition', {
          text: '中文',
          selectionStart: 2,
          selectionEnd: 2,
        })
        await expect.poll(() => placement(win)).toEqual({ pastRight: 0, pastLeft: 0, scrolled: 0 })
        await cdp.send('Input.insertText', { text: '中文' })
        await win.keyboard.press('Enter')
        await win.keyboard.type("printf '\\033[?1049l'")
        await win.keyboard.press('Enter')
        await expect.poll(() => placement(win)).toEqual({ pastRight: 0, pastLeft: 0, scrolled: 0 })
      }
    } finally {
      await app.close()
    }
  })
}
