import { freshDataHome, isolatedLaunch, SOFTWARE_WEBGL, seedSettings } from './dataHome'
import { changeSettings, closeAllWorkspaces, openWorkspace } from './helpers'
import { type PixelRegion, regionColors } from './pixels'
import {
  type ElectronApplication,
  expect,
  type Locator,
  launchShared,
  type Page,
  test,
} from './test'

const ENGINES = [
  { name: 'xterm, GPU off', renderer: 'xterm', gpu: false, grid: '.xterm-screen' },
  { name: 'xterm, GPU on', renderer: 'xterm', gpu: true, grid: '.xterm-screen' },
  { name: 'Ghostty, GPU off', renderer: 'ghostty', gpu: false, grid: '.ghostty-screen' },
  { name: 'Ghostty, GPU on', renderer: 'ghostty', gpu: true, grid: '.ghostty-screen' },
]

const SCHEMES = [
  { name: 'the app theme’s scheme', theme: 'match', background: '22,22,22' },
  { name: 'its own scheme', theme: 'solarized-light', background: '253,246,227' },
]

type Painted = { left: string[]; right: string[]; top: string[]; bottom: string[]; grid: string[] }

async function painted(win: Page, pane: Locator, gridSelector: string): Promise<Painted> {
  const paneBox = await pane.boundingBox()
  const gridBox = await pane.locator(gridSelector).first().boundingBox()
  if (!paneBox || !gridBox) throw new Error('no terminal to measure')
  const png = await pane.screenshot()
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  const scale = width / paneBox.width
  const gridLeft = Math.floor((gridBox.x - paneBox.x) * scale)
  const gridTop = Math.floor((gridBox.y - paneBox.y) * scale)
  const gridRight = Math.ceil((gridBox.x - paneBox.x + gridBox.width) * scale)
  const gridBottom = Math.ceil((gridBox.y - paneBox.y + gridBox.height) * scale)
  const inset = Math.round(8 * scale)
  const patch = Math.round(48 * scale)
  const regions: PixelRegion[] = [
    { x0: 0, y0: 0, x1: gridLeft, y1: height },
    { x0: gridRight, y0: 0, x1: width, y1: height },
    { x0: 0, y0: 0, x1: width, y1: gridTop },
    { x0: 0, y0: gridBottom, x1: width, y1: height },
    {
      x0: gridRight - inset - patch,
      y0: gridBottom - inset - patch,
      x1: gridRight - inset,
      y1: gridBottom - inset,
    },
  ]
  const [left, right, top, bottom, grid] = await regionColors(png, win, regions)
  return { left, right, top, bottom, grid }
}

let app: ElectronApplication | undefined
let win: Page

test.describe('around the text grid', () => {
  test.beforeAll(async () => {
    const dataHome = freshDataHome()
    seedSettings(dataHome, {
      appearance: { theme: 'oxocarbon', followSystem: false },
      workspaces: { confirmQuit: false },
    })
    const launch = isolatedLaunch(dataHome)
    app = await launchShared({ ...launch, args: [SOFTWARE_WEBGL, ...launch.args] })
    win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
  })

  test.afterEach(async () => {
    await closeAllWorkspaces(win)
  })

  test.afterAll(async () => {
    await app?.close()
  })

  for (const engine of ENGINES) {
    for (const scheme of SCHEMES) {
      test(`the padding around the text grid has the terminal background (${engine.name}, ${scheme.name})`, {
        tag: engine.renderer === 'ghostty' ? '@experimental' : [],
      }, async () => {
        await changeSettings(win, {
          behavior: { gpuAcceleration: engine.gpu },
          terminal: { renderer: engine.renderer, theme: scheme.theme },
        })
        await openWorkspace(win)
        const pane = win.locator('.pane-body-term').first()
        const background = [scheme.background]
        await expect
          .poll(() => painted(win, pane, engine.grid))
          .toEqual({
            left: background,
            right: background,
            top: background,
            bottom: background,
            grid: background,
          })
      })
    }
  }
})
