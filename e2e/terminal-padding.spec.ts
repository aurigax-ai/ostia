import { SOFTWARE_WEBGL, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { fakeAgentBin, isolatedHome } from './fakeAgent'
import { PROMPT, openWorkspace } from './helpers'
import { type PixelRegion, regionColors } from './pixels'
import { type Locator, type Page, _electron as electron, expect, test } from './test'

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

const RESUMABLE_AGENT = [
  '#!/bin/sh',
  'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" resume-token claude e2e-padding',
  'echo "fake agent up"',
  'exec sleep 600',
  '',
].join('\n')

const channels = (colour: string): number[] => colour.split(',').map(Number)

const blendingDrift = (a: number[], b: number[]): number =>
  Math.max(...a.map((channel, i) => Math.abs(channel - b[i])))

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

for (const engine of ENGINES) {
  for (const scheme of SCHEMES) {
    test(
      `the padding around the text grid has the terminal background (${engine.name}, ${scheme.name})`,
      { tag: engine.renderer === 'ghostty' ? '@experimental' : [] },
      async () => {
        const dataHome = freshDataHome()
        seedSettings(dataHome, {
          appearance: { theme: 'oxocarbon', followSystem: false },
          behavior: { gpuAcceleration: engine.gpu },
          terminal: { renderer: engine.renderer, theme: scheme.theme },
          workspaces: { confirmQuit: false },
        })
        const launch = isolatedLaunch(dataHome)
        const app = await electron.launch({ ...launch, args: [SOFTWARE_WEBGL, ...launch.args] })
        try {
          const win = await app.firstWindow()
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
        } finally {
          await app.close()
        }
      },
    )
  }
}

test('the padding of a hibernated pane’s screen has the colour of its text grid', async () => {
  test.setTimeout(60_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    appearance: { theme: 'oxocarbon', followSystem: false },
    behavior: { gpuAcceleration: false },
    terminal: { theme: 'solarized-light' },
    workspaces: { confirmQuit: false },
  })
  const bin = fakeAgentBin(dataHome, RESUMABLE_AGENT)
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, HOME: isolatedHome(dataHome), PATH: `${bin}:${launch.env.PATH ?? ''}` },
  })
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    const rows = win.locator('.xterm-rows').first()
    await expect(rows).toContainText(PROMPT, { timeout: 15_000 })
    await win.locator('.xterm').first().click()
    await win.keyboard.type('claude')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('fake agent up', { timeout: 15_000 })

    await win.locator('.rail-tab-main').first().click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Hibernate agents' }).click()
    const screen = win.locator('.hibernated-screen')
    await expect(screen.locator('.xterm-rows')).toContainText('fake agent up', { timeout: 15_000 })

    const colours = await painted(win, screen, '.xterm-screen')
    const [grid] = colours.grid.map(channels)
    for (const colour of [...colours.left, ...colours.top, ...colours.bottom, ...colours.grid]) {
      expect(blendingDrift(channels(colour), grid)).toBeLessThanOrEqual(1)
    }
  } finally {
    await app.close()
  }
})
