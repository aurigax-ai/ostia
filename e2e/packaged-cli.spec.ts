import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, test } from './test'

const PACKAGED = process.env.OSTIA_E2E_PACKAGED ?? ''

test('PKG-C1 the packaged ostia CLI prints the version of the build it ships with', () => {
  test.skip(PACKAGED === '', 'runs only against a packaged build: OSTIA_E2E_PACKAGED=<executable>')
  const resources = join(dirname(PACKAGED), 'resources')
  const stamp = JSON.parse(readFileSync(join(resources, 'build-info.json'), 'utf8'))
  const run = spawnSync(join(resources, 'bin', 'ostia'), ['--version'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
  })
  expect(run.stderr).toBe('')
  expect(run.status).toBe(0)
  expect(run.stdout).toBe(`${stamp.version}\n`)
})
