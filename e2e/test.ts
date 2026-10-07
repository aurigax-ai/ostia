import { rmSync } from 'node:fs'
import {
  type Electron,
  type ElectronApplication,
  test as base,
  _electron as playwrightElectron,
} from '@playwright/test'

export * from '@playwright/test'

const recording = new Map<ElectronApplication, string>()
const recorded: string[] = []

function recordsTrace(): boolean {
  const option = base.info().project.use.trace
  const mode = typeof option === 'string' ? option : option?.mode
  return mode === 'on' || mode === 'retain-on-failure'
}

async function stopTrace(app: ElectronApplication): Promise<void> {
  const path = recording.get(app)
  if (!path) return
  recording.delete(app)
  try {
    await app.context().tracing.stop({ path })
    recorded.push(path)
  } catch {
    rmSync(path, { force: true })
  }
}

function processExit(app: ElectronApplication): Promise<void> {
  const child = app.process()
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', () => resolve()))
}

export const _electron: Electron = {
  async launch(options) {
    const app = await playwrightElectron.launch(options)
    if (!recordsTrace()) return app
    const path = base.info().outputPath(`app-trace-${recording.size + recorded.length + 1}.zip`)
    await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
    recording.set(app, path)
    const close = app.close.bind(app)
    app.close = async () => {
      const exited = processExit(app)
      await stopTrace(app)
      await close()
      await exited
    }
    return app
  },
}

export const test = base.extend<{ appTraces: undefined }>({
  appTraces: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from this pattern
    async ({}, use, testInfo) => {
      await use(undefined)
      await Promise.all([...recording.keys()].map(stopTrace))
      const failed = testInfo.status !== testInfo.expectedStatus
      for (const path of recorded.splice(0)) {
        if (failed) await testInfo.attach('trace', { path, contentType: 'application/zip' })
        rmSync(path, { force: true })
      }
    },
    { auto: true },
  ],
})
