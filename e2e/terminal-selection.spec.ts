import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DOM_RENDERER_SETTINGS,
  SOFTWARE_WEBGL,
  freshDataHome,
  isolatedLaunch,
  seedSettings,
} from './dataHome'
import { fakeAgentBin } from './fakeAgent'
import { emptyState, emptyWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

const AGENT_PANEL = [55, 55, 55]

const MOUSE_TRACKING_AGENT = `#!/bin/sh
stty raw -echo
printf '\\033[?1000h\\033[?1002h\\033[?1006h\\033[2J\\033[H'
i=0
while [ $i -lt 4 ]; do
  printf '\\033[48;2;55;55;55m%-60s\\033[0m\\r\\n' "painted agent output line $i"
  i=$((i + 1))
done
printf '\\342\\225\\255\\342\\224\\200\\342\\225\\256\\r\\n\\342\\224\\202 > \\342\\224\\202\\r\\n'
stty size > "$HOME/agent-size.tmp" && mv "$HOME/agent-size.tmp" "$HOME/agent-size"
exec cat > /dev/null
`

type Rgb = [number, number, number]

async function dominantColors(
  page: Page,
  png: Buffer,
  regions: { x0: number; x1: number; y0: number; y1: number }[],
): Promise<Rgb[]> {
  return page.evaluate(
    async ({ b64, regions }) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return []
      ctx.drawImage(img, 0, 0)
      return regions.map(({ x0, x1, y0, y1 }) => {
        const { data } = ctx.getImageData(x0, y0, x1 - x0, y1 - y0)
        const counts = new Map<string, number>()
        for (let i = 0; i < data.length; i += 4) {
          const key = `${data[i]},${data[i + 1]},${data[i + 2]}`
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
        const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1])
        return top[0].split(',').map(Number) as [number, number, number]
      })
    },
    { b64: png.toString('base64'), regions },
  )
}

const distance = (a: Rgb, b: number[]): number =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])

for (const renderer of ['webgl', 'dom'] as const) {
  test(`a Shift-drag over an agent's painted output makes a visible selection (${renderer})`, async () => {
    const dataHome = freshDataHome()
    seedSettings(dataHome, {
      ...DOM_RENDERER_SETTINGS,
      appearance: { theme: 'oxocarbon' },
      behavior: { gpuAcceleration: renderer === 'webgl', inputMode: 'editor' },
    })
    const bin = fakeAgentBin(dataHome, MOUSE_TRACKING_AGENT)
    const launch = isolatedLaunch(dataHome)
    const app = await electron.launch({
      ...launch,
      args: [SOFTWARE_WEBGL, ...launch.args],
      env: { ...launch.env, PATH: `${bin}:${launch.env.PATH}` },
    })
    try {
      const win = await app.firstWindow()
      await emptyState(win)
        .getByRole('button', { name: /New workspace/ })
        .click()
      await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
      const screen = win.locator('.xterm-screen').first()
      if (renderer === 'webgl') {
        await expect(screen.locator('canvas').first()).toBeVisible({ timeout: 15_000 })
      } else {
        await expect(win.locator('.xterm-rows').first()).toContainText(/[❯$%#]/, {
          timeout: 15_000,
        })
      }
      await win.waitForTimeout(1_500)
      await win.locator('.xterm').first().click()
      await win.keyboard.type('claude')
      await win.keyboard.press('Enter')
      const sizeFile = join(launch.home, 'agent-size')
      await expect.poll(() => existsSync(sizeFile), { timeout: 15_000 }).toBe(true)
      await expect(win.locator('.xterm').first()).toHaveClass(/enable-mouse-events/)
      const [rows, cols] = readFileSync(sizeFile, 'utf8').trim().split(' ').map(Number)
      const box = await screen.boundingBox()
      if (!box) throw new Error('no terminal screen')
      const cellWidth = box.width / cols
      const cellHeight = box.height / rows
      const rowCenter = box.y + cellHeight * 1.5
      const colX = (col: number): number => box.x + cellWidth * (col + 0.5)

      await win.keyboard.down('Shift')
      await win.mouse.move(colX(2), rowCenter)
      await win.mouse.down()
      await win.mouse.move(colX(20), rowCenter, { steps: 6 })
      await win.mouse.move(colX(36), rowCenter, { steps: 6 })
      await win.mouse.up()
      await win.keyboard.up('Shift')

      await app.evaluate(({ clipboard }) => clipboard.writeText(''))
      await win.keyboard.press('Control+Shift+C')
      await expect
        .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
        .toContain('agent output line 1')

      const png = await screen.screenshot()
      const scale = (png.readUInt32BE(16) || box.width) / box.width
      const band = (from: number, to: number) => ({
        x0: Math.round(cellWidth * from * scale),
        x1: Math.round(cellWidth * to * scale),
        y0: Math.round(cellHeight * 1 * scale),
        y1: Math.round(cellHeight * 2 * scale),
      })
      const [selected, unselected] = await dominantColors(win, png, [band(3, 36), band(40, 58)])
      expect(distance(unselected, AGENT_PANEL)).toBeLessThan(6)
      expect(distance(selected, unselected)).toBeGreaterThan(40)
    } finally {
      await app.close()
    }
  })
}
