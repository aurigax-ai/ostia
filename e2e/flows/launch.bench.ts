import { cpSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chords } from '../chords'
import { freshDataHome, seedSettings, testHome } from '../dataHome'
import { openWorkspace, quitApp } from '../helpers'
import { expect, test } from '../test'
import {
  firstContentfulPaint,
  launchBare,
  launchPlain,
  launchProbed,
  readLaunchMarks,
  readPageMarks,
  SHOWN_INPUT,
  shownRows,
  stopProfile,
} from './flowApp'
import { Samples, WARMUP } from './flowResults'

const LAUNCHES = Number(process.env.OSTIA_FLOW_LAUNCHES ?? 10)
const RESTORED_PROMPT = '⟫'
const SETTINGS = { behavior: { gpuAcceleration: false }, workspaces: { confirmQuit: false } }

function replaceContents(target: string, snapshot: string): void {
  for (const name of readdirSync(target))
    rmSync(join(target, name), { recursive: true, force: true })
  cpSync(snapshot, target, { recursive: true })
}

function useRestoredPrompt(dataHome: string): void {
  const home = testHome(dataHome)
  writeFileSync(join(home, '.zshrc'), `PROMPT='%~ ${RESTORED_PROMPT} '\n`)
  writeFileSync(join(home, '.bashrc'), `PS1='\\w ${RESTORED_PROMPT} '\n`)
}

test('bench launch: empty app to window shown and first paint', async () => {
  test.setTimeout(300_000)
  const samples = new Samples()
  for (let i = 0; i < LAUNCHES + WARMUP; i++) {
    const dataHome = freshDataHome()
    seedSettings(dataHome, SETTINGS)
    const profile = process.env.OSTIA_FLOW_PROFILE_DIR
    const { app, win } = await launchProbed(
      dataHome,
      {},
      profile ? join(profile, `launch-${i}.cpuprofile`) : undefined,
    )
    try {
      await expect.poll(() => firstContentfulPaint(win)).not.toBeNaN()
      if (profile) await stopProfile(app)
      const marks = await readLaunchMarks(app)
      if (i < WARMUP) continue
      samples.add('launch.app-ready', (marks.appReady ?? Number.NaN) - marks.processStart)
      samples.add('launch.window-created', (marks.windowCreated ?? Number.NaN) - marks.processStart)
      samples.add('launch.dom-ready', (marks.domReady ?? Number.NaN) - marks.processStart)
      samples.add('launch.window-shown', (marks.readyToShow ?? Number.NaN) - marks.processStart)
      samples.add('launch.first-paint', (await firstContentfulPaint(win)) - marks.processStart)
    } finally {
      await quitApp(app)
    }
  }
  samples.flush()
})

test('bench launch: bare Electron app floor', async () => {
  test.setTimeout(120_000)
  const samples = new Samples()
  for (let i = 0; i < LAUNCHES + WARMUP; i++) {
    const dataHome = freshDataHome()
    writeFileSync(join(dataHome, 'flow-page.js'), '')
    const { app } = await launchBare(dataHome)
    try {
      await expect
        .poll(async () => (await readLaunchMarks(app)).domReady, { timeout: 15_000 })
        .toBeGreaterThan(0)
      const marks = await readLaunchMarks(app)
      if (i < WARMUP) continue
      samples.add('launch.floor-app-ready', (marks.appReady ?? Number.NaN) - marks.processStart)
      samples.add('launch.floor-dom-ready', (marks.domReady ?? Number.NaN) - marks.processStart)
    } finally {
      await quitApp(app)
    }
  }
  samples.flush()
})

test('bench restore: saved workspace with a split tab and two more tabs to shown prompt and all panes', async () => {
  test.setTimeout(600_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, SETTINGS)
  const seed = await launchPlain(dataHome)
  try {
    await openWorkspace(seed.win)
    for (const count of [2, 3]) {
      await seed.win.keyboard.press(chords.newTab)
      await expect(seed.win.locator('.xterm')).toHaveCount(count, { timeout: 15_000 })
    }
    await seed.win.keyboard.press(chords.splitRight)
    await expect(seed.win.locator('.xterm')).toHaveCount(4, { timeout: 15_000 })
    await seed.win.waitForTimeout(1_500)
  } finally {
    await quitApp(seed.app)
  }
  const snapshot = `${dataHome}-snapshot`
  cpSync(dataHome, snapshot, { recursive: true })
  const samples = new Samples()
  for (let i = 0; i < LAUNCHES + WARMUP; i++) {
    replaceContents(dataHome, snapshot)
    useRestoredPrompt(dataHome)
    const { app, win } = await launchProbed(dataHome, {
      shownPrompt: [shownRows(RESTORED_PROMPT)],
      allPanes: [shownRows(RESTORED_PROMPT, 2)],
      focus: [SHOWN_INPUT],
    })
    try {
      await expect
        .poll(async () => Object.keys(await readPageMarks(win)).sort(), { timeout: 30_000 })
        .toEqual(['allPanes', 'focus', 'shownPrompt'])
      const page = await readPageMarks(win)
      const marks = await readLaunchMarks(app)
      if (i < WARMUP) continue
      const from = marks.processStart
      samples.add('restore.first-paint', (await firstContentfulPaint(win)) - from)
      samples.add('restore.shown-prompt', page.shownPrompt - from)
      samples.add('restore.all-panes', page.allPanes - from)
      samples.add('restore.focus', page.focus - from)
    } finally {
      await quitApp(app)
    }
  }
  samples.flush()
})
