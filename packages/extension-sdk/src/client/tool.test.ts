import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runTool } from './tool'

const printEnv = [
  '-e',
  'process.stdout.write(JSON.stringify([process.env.TOOL_A ?? null, process.env.TOOL_B ?? null]))',
]

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('runTool', () => {
  it('runs the tool with the extension environment by default', async () => {
    vi.stubEnv('TOOL_A', 'inherited')
    const run = await runTool(process.execPath, printEnv)
    expect(JSON.parse(run.stdout)).toEqual(['inherited', null])
  })

  it('runs the tool with exactly the env it is given', async () => {
    vi.stubEnv('TOOL_A', 'inherited')
    const run = await runTool(process.execPath, printEnv, { env: { TOOL_B: 'given' } })
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual([null, 'given'])
  })
})

const ignoresTerm = [
  '-e',
  "process.on('SIGTERM', () => {}); process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)",
]

const leavesChildOnPipes = [
  '-e',
  "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); process.stdout.write(String(c.pid)); c.unref()",
]

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50 && isAlive(pid); i++) await sleep(100)
  return !isAlive(pid)
}

describe('runTool timeout', () => {
  it('answers at the timeout and kills a tool that ignores SIGTERM', async () => {
    const started = Date.now()
    const run = await runTool(process.execPath, ignoresTerm, { timeoutMs: 500 })
    expect(Date.now() - started).toBeLessThan(1500)
    expect(run).toMatchObject({ code: null, timedOut: true, missing: false })
    expect(await gone(Number(run.stdout))).toBe(true)
  })

  it('answers at the timeout and kills a child the tool left holding its output', async () => {
    const started = Date.now()
    const run = await runTool(process.execPath, leavesChildOnPipes, { timeoutMs: 500 })
    expect(Date.now() - started).toBeLessThan(1500)
    expect(run.timedOut).toBe(true)
    expect(await gone(Number(run.stdout))).toBe(true)
  })
})
