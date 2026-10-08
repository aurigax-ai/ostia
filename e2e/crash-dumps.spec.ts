import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedLaunch } from './dataHome'
import {
  crashDumpsIn,
  crashDumpsPossible,
  _electron as electron,
  exitLine,
  exitReport,
  expect,
  test,
} from './test'

test('a main process that crashes during a test leaves its signal and a crash dump for the report, or says why there is no dump', async () => {
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
  if (crashDumpsPossible()) {
    await expect.poll(() => crashDumpsIn(dumps).length, { timeout: 15_000 }).toBeGreaterThan(0)
    expect(exitReport(child, crashDumpsIn(dumps))).toBe(exitLine(child))
  } else {
    expect(crashDumpsIn(dumps)).toEqual([])
    expect(exitReport(child, [])).toContain('no crash dump: this machine forbids ptrace')
  }
})

interface ReportedAttachment {
  name: string
  path?: string
  body?: string
}

interface FailedRun {
  status: string
  attachments: ReportedAttachment[]
}

function failingRun(outputDir: string): Promise<FailedRun> {
  const { TEST_WORKER_INDEX: _worker, TEST_PARALLEL_INDEX: _parallel, ...env } = process.env
  const args = [
    require.resolve('@playwright/test/cli'),
    'test',
    `--config=${join(__dirname, 'failed-report', 'playwright.config.ts')}`,
    `--output=${outputDir}`,
  ]
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { env, maxBuffer: 64 * 1024 * 1024 }, (_error, stdout) => {
      try {
        resolve(JSON.parse(stdout).suites[0].specs[0].tests[0].results[0])
      } catch {
        reject(new Error(`the failing run printed no report:\n${stdout}`))
      }
    })
  })
}

function textOf(attachment: ReportedAttachment | undefined): string {
  return Buffer.from(attachment?.body ?? '', 'base64').toString('utf8')
}

test('a failed test leaves how its app ended, what the app printed and the main log in the report', async () => {
  test.setTimeout(90_000)
  const run = await failingRun(test.info().outputPath('failing-run'))
  const named = (name: string) => run.attachments.find((attachment) => attachment.name === name)

  expect(run.status).toBe('failed')
  expect(textOf(named('app-exit'))).toMatch(/^the app \(pid \d+\) exited with code 0$/)
  expect(named('app-stderr')).toBeDefined()
  expect(readFileSync(named('main-log')?.path ?? '', 'utf8')).not.toBe('')
})
