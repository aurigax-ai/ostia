import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Tailnet, type TailnetState, createTailnet, tailnetNodeName } from './tailnet'

const root = resolve(__dirname, '../../..')
const fakeHelper = join(root, 'test', 'fixtures', 'tsnet', 'fake-helper.mjs')
const realHelper = join(root, 'out', 'tsnet', 'ostia-tsnet')
const target = { helperPort: 40001, port: 8722 }

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ostia-tailnet-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

interface Harness {
  tailnet: Tailnet
  states: TailnetState[]
  log: ReturnType<typeof vi.fn>
  argvFile: string
  stateDir: string
}

function harness(env: Record<string, string>, stateDir?: string): Harness {
  const dir = scratch()
  const argvFile = join(dir, 'argv.jsonl')
  const states: TailnetState[] = []
  const log = vi.fn()
  const resolvedStateDir = stateDir ?? join(dir, 'tsnet')
  const tailnet = createTailnet({
    command: process.execPath,
    args: [fakeHelper],
    stateDir: resolvedStateDir,
    hostname: 'ostia-test',
    env: { ...process.env, FAKE_TSNET_ARGV: argvFile, ...env },
    onChange: (s) => states.push(s),
    log,
  })
  cleanups.push(() => tailnet.stop())
  return { tailnet, states, log, argvFile, stateDir: resolvedStateDir }
}

function invocations(argvFile: string): string[][] {
  if (!existsSync(argvFile)) return []
  return readFileSync(argvFile, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as string[])
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

const RUNNING = JSON.stringify({
  state: 'running',
  ip: '100.64.0.1',
  dnsName: 'ostia-test.example.ts.net',
})

describe('tailnet node name', () => {
  it('TSN-C20 names the node ostia-<hostname> with only a-z0-9-', () => {
    expect(tailnetNodeName('XPS 15_9530')).toBe('ostia-xps-15-9530')
  })

  it('TSN-C21 falls back to ostia for an empty or all-symbol hostname', () => {
    expect(tailnetNodeName('')).toBe('ostia')
    expect(tailnetNodeName('___ !!')).toBe('ostia')
  })
})

describe('tailnet helper manager', () => {
  it('TSN-C13 reports a helper that exits on its own and does not restart it', async () => {
    const h = harness({
      FAKE_TSNET_LINES: JSON.stringify([RUNNING]),
      FAKE_TSNET_EXIT_AFTER_MS: '100',
    })
    h.tailnet.start(target)
    await until(() => h.tailnet.state().state === 'error')
    expect(h.tailnet.state()).toEqual({ state: 'error', code: 'helper-stopped' })
    await new Promise((r) => setTimeout(r, 400))
    expect(invocations(h.argvFile)).toHaveLength(1)

    h.tailnet.start(target)
    await until(() => invocations(h.argvFile).length === 2)
  })

  it('TSN-C14 ignores lines that are not events and logs only that it did', async () => {
    const h = harness({
      FAKE_TSNET_LINES: JSON.stringify([
        'not json at all',
        '{"state":"bogus","secret":"x"}',
        RUNNING,
      ]),
    })
    h.tailnet.start(target)
    await until(() => h.tailnet.state().state === 'running')
    expect(h.states.map((s) => s.state)).toEqual(['starting', 'running'])
    expect(h.log).toHaveBeenCalledTimes(2)
    for (const call of h.log.mock.calls) {
      expect(call[0]).toBe('tailnet.helper-line-ignored')
      expect(JSON.stringify(call)).not.toMatch(/not json|bogus|secret/)
    }
  })

  it('TSN-C18 refuses a state folder that is a symlink', async () => {
    const dir = scratch()
    const real = join(dir, 'real')
    mkdirSync(real)
    const link = join(dir, 'tsnet')
    symlinkSync(real, link)
    const h = harness({ FAKE_TSNET_LINES: JSON.stringify([RUNNING]) }, link)
    h.tailnet.start(target)
    expect(h.tailnet.state()).toEqual({ state: 'error', code: 'state-dir-unsafe' })
    await new Promise((r) => setTimeout(r, 200))
    expect(invocations(h.argvFile)).toHaveLength(0)
  })

  it('TSN-C36 stops the helper but keeps the node signed in', async () => {
    const h = harness({ FAKE_TSNET_LINES: JSON.stringify([RUNNING]) })
    h.tailnet.start(target)
    await until(() => h.tailnet.state().state === 'running')
    await h.tailnet.stop()
    expect(h.tailnet.state()).toEqual({ state: 'off' })
    expect(existsSync(h.stateDir)).toBe(true)
    expect(invocations(h.argvFile).some((a) => a.includes('--logout'))).toBe(false)
  })

  it('TSN-C17 signs out by logging the node out and deleting its state folder', async () => {
    const h = harness({ FAKE_TSNET_LINES: JSON.stringify([RUNNING]) })
    h.tailnet.start(target)
    await until(() => h.tailnet.state().state === 'running')
    await h.tailnet.signOut()
    const logout = invocations(h.argvFile).find((a) => a.includes('--logout'))
    expect(logout).toEqual(expect.arrayContaining(['--logout', '--dir', h.stateDir]))
    expect(existsSync(h.stateDir)).toBe(false)
    expect(h.tailnet.state()).toEqual({ state: 'off' })
  })

  it('TSN-C15 the helper exits when its stdin closes', async () => {
    const child = spawn(realHelper, [
      '--listen-local',
      '127.0.0.1:0',
      '--port',
      '1',
      '--target',
      '127.0.0.1:1',
    ])
    cleanups.push(() => {
      child.kill()
    })
    await new Promise<void>((r) => child.stdout.once('data', () => r()))
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)))
    child.stdin.end()
    const code = await Promise.race([
      exited,
      new Promise<string>((r) => setTimeout(() => r('still running'), 3000)),
    ])
    expect(code).toBe(0)
  })
})
