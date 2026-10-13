import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildVersionAt } from './version'

function outDir(info: unknown): string {
  const out = mkdtempSync(join(tmpdir(), 'ostia-version-'))
  mkdirSync(join(out, 'cli'))
  if (info !== undefined) writeFileSync(join(out, 'build-info.json'), JSON.stringify(info))
  return join(out, 'cli')
}

describe('buildVersionAt', () => {
  it('reads the full build version from the stamp beside the CLI folder', () => {
    const cli = outDir({ version: '0.5.9-rc.3+sha.1a2b3c.dirty', builtAt: '2026-10-06T00:00:00Z' })
    expect(buildVersionAt(cli)).toBe('0.5.9-rc.3+sha.1a2b3c.dirty')
  })

  it('answers nothing without a valid stamp', () => {
    expect(buildVersionAt(outDir(undefined))).toBeNull()
    expect(buildVersionAt(outDir({ version: '0.5.9' }))).toBeNull()
  })
})

describe('ostia --version', () => {
  it('prints the version of the build it ships with', () => {
    const repoRoot = process.cwd()
    const stamp = JSON.parse(readFileSync(join(repoRoot, 'out', 'build-info.json'), 'utf8'))
    const run = spawnSync(
      process.execPath,
      [join(repoRoot, 'out', 'cli', 'index.js'), '--version'],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      },
    )
    expect(run.status).toBe(0)
    expect(run.stdout).toBe(`${stamp.version}\n`)
  })
})
