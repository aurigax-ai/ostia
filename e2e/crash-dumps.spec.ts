import { isolatedLaunch } from './dataHome'
import { crashDumpsIn, _electron as electron, exitLine, expect, test } from './test'

test('a main process that crashes during a test leaves its signal and a crash dump for the report', async () => {
  const dumps = test.info().outputPath('asked-crash-dumps')
  const launch = isolatedLaunch()
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, OSTIA_E2E_CRASH_DUMPS: dumps },
  })
  const child = app.process()
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  await app.firstWindow()
  expect(await app.evaluate(() => process.env.OSTIA_E2E_CRASH_DUMPS)).toBeUndefined()

  await app.evaluate(() => process.crash()).catch(() => {})
  await exited

  expect(exitLine(child)).toMatch(/was ended by SIG[A-Z]+/)
  await expect.poll(() => crashDumpsIn(dumps).length, { timeout: 15_000 }).toBeGreaterThan(0)
})
