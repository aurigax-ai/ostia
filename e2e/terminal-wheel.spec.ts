import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { GHOSTTY } from './ghostty'
import { openWorkspace, typeLine } from './helpers'
import { _electron as electron, expect, test } from './test'

const WHEEL_NOTCH = 120

const WHEEL_COUNTER = `
const { writeFileSync } = require('node:fs')
const out = process.argv[2]
const counts = { 64: 0, 65: 0, A: 0, B: 0 }
let pending = ''
let synced = 0
process.stdin.setRawMode(true)
process.stdin.on('data', (chunk) => {
  pending += chunk.toString('latin1')
  for (;;) {
    const input = /\\x1b\\[<(\\d+);\\d+;\\d+[Mm]|\\x1b[\\[O]([AB])|\\x1b\\[\\d+;\\d+(R)|(a)/.exec(pending)
    if (!input) break
    pending = pending.slice(input.index + input[0].length)
    const key = input[1] ?? input[2]
    if (key in counts) counts[key] += 1
    if (input[3]) synced += 1
    if (input[4]) process.stdout.write('\\x1b[?1000l\\x1b[6n')
  }
  const mode = synced > 1 ? 'arrows' : 'reports'
  if (synced) writeFileSync(out, [mode, counts[65], counts[64], counts.B, counts.A].join(' '))
})
process.stdout.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h\\x1b[2Jwheel-counter\\x1b[6n')
`

const ENGINES = [
  { name: 'xterm.js', settings: DOM_RENDERER_SETTINGS, screen: '.xterm-screen' },
  { name: 'Ghostty', settings: GHOSTTY, screen: '.ghostty-screen' },
]

test.skip(process.platform !== 'linux', 'wheel notches are counted on Linux')

for (const engine of ENGINES) {
  test(`${engine.name}: a wheel event sends a full-screen program one report or arrow key per notch it carries`, async () => {
    test.setTimeout(60_000)
    const dataHome = freshDataHome()
    seedSettings(dataHome, engine.settings)
    const script = join(dataHome, 'wheel-counter.cjs')
    const counts = join(dataHome, 'wheel-counts')
    writeFileSync(script, WHEEL_COUNTER)
    const launch = isolatedLaunch(dataHome)
    const app = await electron.launch({ ...launch, env: { ...launch.env, SHELL: '/bin/zsh' } })
    try {
      const win = await app.firstWindow()
      await openWorkspace(win)
      const screen = win.locator(engine.screen).first()
      await screen.click()
      await typeLine(win, `'${process.execPath}' '${script}' '${counts}'`)
      const seen = (): string => {
        try {
          return readFileSync(counts, 'utf8')
        } catch {
          return ''
        }
      }
      await expect.poll(seen, { timeout: 15_000 }).toBe('reports 0 0 0 0')
      await screen.hover()
      await win.mouse.wheel(0, 3 * WHEEL_NOTCH)
      await expect.poll(seen, { timeout: 15_000 }).toBe('reports 3 0 0 0')
      await win.mouse.wheel(0, -WHEEL_NOTCH)
      await expect.poll(seen, { timeout: 15_000 }).toBe('reports 3 1 0 0')
      await win.keyboard.type('a')
      await expect.poll(seen, { timeout: 15_000 }).toBe('arrows 3 1 0 0')
      await win.mouse.wheel(0, 2 * WHEEL_NOTCH)
      await expect.poll(seen, { timeout: 15_000 }).toBe('arrows 3 1 2 0')
      await win.mouse.wheel(0, -WHEEL_NOTCH)
      await expect.poll(seen, { timeout: 15_000 }).toBe('arrows 3 1 2 1')
    } finally {
      await app.close()
    }
  })
}
