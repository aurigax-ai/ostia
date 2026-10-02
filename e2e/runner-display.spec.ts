import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { freshDataHome } from './dataHome'

const RUNNER = resolve(__dirname, '../scripts/e2e.sh')
const CONCURRENT_RUNS = 6

function hasXvfb(): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v Xvfb'])
    return true
  } catch {
    return false
  }
}

function fakePlaywright(): string {
  const bin = join(freshDataHome(), 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'playwright'), '#!/bin/sh\necho "$DISPLAY"\nsleep 1\n')
  chmodSync(join(bin, 'playwright'), 0o755)
  return bin
}

function displayOfRun(bin: string): Promise<string> {
  const { PINE_E2E_VISIBLE: _visible, ...inherited } = process.env
  return new Promise((done, fail) => {
    execFile(
      'bash',
      [RUNNER],
      { env: { ...inherited, PATH: `${bin}:${process.env.PATH}` } },
      (error, stdout) => (error ? fail(error) : done(stdout.trim())),
    )
  })
}

test('test runs started at the same moment each get a virtual display of their own', async () => {
  test.skip(!hasXvfb(), 'needs Xvfb')
  const bin = fakePlaywright()
  const displays = await Promise.all(
    Array.from({ length: CONCURRENT_RUNS }, () => displayOfRun(bin)),
  )
  for (const display of displays) expect(display).toMatch(/^:\d+$/)
  expect(new Set(displays).size).toBe(CONCURRENT_RUNS)
  expect(displays).not.toContain(process.env.DISPLAY)
})
