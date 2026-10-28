import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedLaunch } from '../dataHome'
import { type ElectronApplication, _electron as electron, expect, type Page } from '../test'
import { type Condition, type FlowWindow, flowProbe, type StartEvent } from './pageProbe'

export const PROMPT_TEXT = '[❯$%#⟫]'

export function shownRows(text: string, min = 1): Condition {
  return { sel: '.xterm-rows', text, min, shown: true }
}

export const SHOWN_INPUT: Condition = { sel: '.xterm-helper-textarea', shown: true, focus: true }

const MAIN_PROBE = `
const { app } = require('electron')
const fs = require('node:fs')
const marks = { processStart: process.getCreationTime() }
let mainSession = null
if (process.env.OSTIA_FLOW_PROFILE) {
  mainSession = new (require('node:inspector').Session)()
  mainSession.connect()
  mainSession.post('Profiler.enable')
  mainSession.post('Profiler.start')
}
globalThis.__launchMarks = marks
app.whenReady().then(() => { marks.appReady = Date.now() })
app.on('browser-window-created', (_event, win) => {
  marks.windowCreated = Date.now()
  if (mainSession) {
    mainSession.post('Profiler.stop', (_err, result) => {
      fs.writeFileSync(process.env.OSTIA_FLOW_PROFILE + '.main', JSON.stringify(result.profile))
    })
    mainSession = null
  }
  if (process.env.OSTIA_FLOW_PROFILE) {
    const dbg = win.webContents.debugger
    dbg.attach('1.3')
    dbg.sendCommand('Profiler.enable').then(() => dbg.sendCommand('Profiler.start'))
    globalThis.__stopProfile = async () => {
      const { profile } = await dbg.sendCommand('Profiler.stop')
      fs.writeFileSync(process.env.OSTIA_FLOW_PROFILE, JSON.stringify(profile))
    }
  }
  win.once('ready-to-show', () => { marks.readyToShow = Date.now() })
  win.webContents.once('dom-ready', () => {
    marks.domReady = Date.now()
    win.webContents.executeJavaScript(fs.readFileSync(process.env.OSTIA_FLOW_PAGE, 'utf8'))
  })
})
`

export interface Launched {
  app: ElectronApplication
  win: Page
  startedAt: number
}

function pageScript(ends: Record<string, Condition[]>): string {
  return `(${flowProbe.toString()})(); window.__flow.begin(null, ${JSON.stringify(ends)})`
}

export async function launchProbed(
  dataHome: string,
  ends: Record<string, Condition[]>,
  profilePath?: string,
): Promise<Launched> {
  const probe = join(dataHome, 'flow-main.cjs')
  const page = join(dataHome, 'flow-page.js')
  writeFileSync(probe, MAIN_PROBE)
  writeFileSync(page, pageScript(ends))
  const launch = isolatedLaunch(dataHome)
  const startedAt = Date.now()
  const app = await electron.launch({
    args: ['-r', probe, ...launch.args],
    env: {
      ...launch.env,
      OSTIA_FLOW_PAGE: page,
      ...(profilePath ? { OSTIA_FLOW_PROFILE: profilePath } : {}),
    },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win, startedAt }
}

export async function launchBare(dataHome: string): Promise<Launched> {
  const probe = join(dataHome, 'flow-main.cjs')
  const bare = join(dataHome, 'bare')
  mkdirSync(bare, { recursive: true })
  writeFileSync(probe, MAIN_PROBE)
  writeFileSync(join(bare, 'package.json'), JSON.stringify({ name: 'bare', main: 'main.js' }))
  writeFileSync(
    join(bare, 'main.js'),
    "const { app, BrowserWindow } = require('electron')\napp.whenReady().then(() => new BrowserWindow({ show: false }).loadURL('about:blank'))\n",
  )
  const startedAt = Date.now()
  const app = await electron.launch({
    args: ['-r', probe, `--user-data-dir=${join(dataHome, 'userData')}`, bare],
    env: {
      ...(process.env as Record<string, string>),
      OSTIA_FLOW_PAGE: join(dataHome, 'flow-page.js'),
    },
  })
  const win = await app.firstWindow()
  return { app, win, startedAt }
}

export async function launchPlain(
  dataHome: string,
  env: Record<string, string> = {},
): Promise<Launched> {
  const launch = isolatedLaunch(dataHome)
  const startedAt = Date.now()
  const app = await electron.launch({ args: launch.args, env: { ...launch.env, ...env } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(flowProbe)
  return { app, win, startedAt }
}

export interface LaunchMarks {
  processStart: number
  appReady?: number
  windowCreated?: number
  readyToShow?: number
  domReady?: number
}

export function stopProfile(app: ElectronApplication): Promise<void> {
  return app.evaluate(() =>
    (globalThis as unknown as { __stopProfile?: () => Promise<void> }).__stopProfile?.(),
  )
}

export function readLaunchMarks(app: ElectronApplication): Promise<LaunchMarks> {
  return app.evaluate(() => (globalThis as unknown as { __launchMarks: LaunchMarks }).__launchMarks)
}

export function readPageMarks(win: Page): Promise<Record<string, number>> {
  return win.evaluate(() => (window as FlowWindow).__flow?.read() ?? {})
}

export async function firstContentfulPaint(win: Page): Promise<number> {
  return win.evaluate(() => {
    const entry = performance.getEntriesByName('first-contentful-paint')[0]
    return entry ? performance.timeOrigin + entry.startTime : Number.NaN
  })
}

export interface Measure {
  start: StartEvent | null
  ends: Record<string, Condition[]>
  act: () => Promise<void>
  timeoutMs?: number
}

export async function measure(win: Page, spec: Measure): Promise<Record<string, number>> {
  const already = await win.evaluate(
    ({ start, ends }) => (window as FlowWindow).__flow?.begin(start, ends) ?? ['no-probe'],
    { start: spec.start, ends: spec.ends },
  )
  if (already.length > 0) throw new Error(`flow ends already true before the action: ${already}`)
  const before = Date.now()
  await spec.act()
  const names = Object.keys(spec.ends)
  await expect
    .poll(
      async () => {
        const marks = await readPageMarks(win)
        return names.every((n) => n in marks)
      },
      { timeout: spec.timeoutMs ?? 15_000 },
    )
    .toBe(true)
  const marks = await readPageMarks(win)
  const from = marks.start ?? before
  return Object.fromEntries(names.map((n) => [n, marks[n] - from]))
}
