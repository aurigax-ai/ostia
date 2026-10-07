import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const retry = join(process.cwd(), 'scripts', 'retry.sh')
const root = mkdtempSync(join(tmpdir(), 'ostia-retry-'))

afterAll(() => rmSync(root, { recursive: true, force: true }))

function run(env: Record<string, string>, ...command: string[]) {
  const result = spawnSync('bash', [retry, ...command], {
    env: { ...process.env, RETRY_DELAY: '0', ...env },
    encoding: 'utf8',
    timeout: 30_000,
  })
  return { status: result.status, stderr: result.stderr }
}

describe('scripts/retry.sh', () => {
  it('runs a command once when it succeeds', () => {
    const { status, stderr } = run({}, 'true')
    expect(status).toBe(0)
    expect(stderr).toBe('')
  })

  it('runs again after a failure and gives up with the last exit status', () => {
    const counter = join(root, 'count')
    writeFileSync(counter, '')
    const script = `echo x >> "${counter}"; test "$(wc -l < "${counter}")" -ge 3`
    const passing = run({ RETRY_ATTEMPTS: '4' }, 'sh', '-c', script)
    expect(passing.status).toBe(0)
    expect(passing.stderr.match(/trying again/g)).toHaveLength(2)

    const failing = run({ RETRY_ATTEMPTS: '2' }, 'sh', '-c', 'exit 7')
    expect(failing.status).toBe(7)
    expect(failing.stderr).toContain("'sh -c exit 7' exited 7 (attempt 1 of 2)")
  })

  it('ends an attempt that hangs and counts it as a failure', () => {
    const started = Date.now()
    const { status, stderr } = run({ RETRY_ATTEMPTS: '2', RETRY_TIMEOUT: '1' }, 'sleep', '60')
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(status).toBe(124)
    expect(stderr.match(/timed out after 1s/g)).toHaveLength(2)
    expect(stderr).toContain('exited 124 (attempt 1 of 2)')
  })
})
