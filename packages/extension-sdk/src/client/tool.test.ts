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
