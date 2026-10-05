import { resolve } from 'node:path'
import { type Locator, _electron as electron, expect, test } from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin } from './fakeAgent'
import { openWorkspace } from './helpers'

const BUSY_AGENT = resolve(__dirname, '../test/fixtures/agents/busy-agent.mjs')
const AGENT_FPS = 30
const WINDOW_MS = 4_000
const MAX_COMMITS = 40
const MAX_SAVES = 6

const COUNT_REACT_COMMITS = `(() => {
  window.__reactCommits = 0
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject(renderer) {
      this.renderers.set(this.renderers.size + 1, renderer)
      return this.renderers.size
    },
    onScheduleFiberRoot() {},
    onCommitFiberRoot() {
      window.__reactCommits++
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  }
})()`

test('an agent that redraws its spinner and title every frame does not re-render the app or flood autosave', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  const bin = fakeAgentBin(
    dataHome,
    `#!/bin/sh\nBUSY_AGENT_FPS=${AGENT_FPS} ELECTRON_RUN_AS_NODE=1 exec "$OSTIA_NODE" "${BUSY_AGENT}"\n`,
  )
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, PATH: `${bin}:${launch.env.PATH}` },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const cdp = await win.context().newCDPSession(win)
    await cdp.send('Page.enable')
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: COUNT_REACT_COMMITS })
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    await app.evaluate(({ ipcMain }) => {
      const counter = globalThis as unknown as { workspaceSaves: number }
      counter.workspaceSaves = 0
      ipcMain.on('workspace:save', () => {
        counter.workspaceSaves++
      })
    })
    const commits = () =>
      win.evaluate(() => (window as unknown as { __reactCommits: number }).__reactCommits)
    const saves = () =>
      app.evaluate(() => (globalThis as unknown as { workspaceSaves: number }).workspaceSaves)

    await openWorkspace(win)
    const rows = win.locator('.xterm-rows').first()
    const title = win.locator('.pane-tab .title').first()
    await win.locator('.xterm').first().click()
    await win.keyboard.type('claude')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('output line 30', { timeout: 15_000 })
    await expect(title).toHaveText(/Busy task$/)

    const frameBefore = await agentFrame(rows)
    const commitsBefore = await commits()
    const savesBefore = await saves()
    await win.waitForTimeout(WINDOW_MS)
    const committed = (await commits()) - commitsBefore
    const saved = (await saves()) - savesBefore
    const frames = (await agentFrame(rows)) - frameBefore

    expect(frames).toBeGreaterThan(MAX_COMMITS * 2)
    expect(committed).toBeLessThan(MAX_COMMITS)
    expect(saved).toBeLessThanOrEqual(MAX_SAVES)

    await win.keyboard.type('ZQXlag')
    await expect(rows).toContainText('ZQXlag')

    await win.keyboard.press('Control+c')
    await expect(rows).toContainText('busy-agent done', { timeout: 15_000 })
    await expect(title).toHaveText('✳ Busy task')
  } finally {
    await app.close()
  }
})

async function agentFrame(rows: Locator): Promise<number> {
  const text = (await rows.textContent()) ?? ''
  const frames = [...text.matchAll(/frame\s(\d+)/g)].map((m) => Number(m[1]))
  return frames.length > 0 ? Math.max(...frames) : 0
}
