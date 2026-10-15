import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runScreens } from './screensCli'
import { ScreensService } from './screensService'
import { type FakeScreens, fakeScreens } from './testFake'

const PROBE = `
import { onShutdown } from '@aurigax-ai/ostia-extension-sdk'
import { ScreensService } from './screensService'
const service = new ScreensService()
onShutdown(() => service.stopAllNow())
async function main() {
  await service.create({ workspaceId: 'A', allow: [] })
  await service.create({ workspaceId: 'B', allow: [] })
  process.stdout.write('ready\\n')
  if (process.argv[2] === 'crash') setTimeout(() => { throw new Error('crash') }, 10)
  else setInterval(() => {}, 1000)
}
void main()
`

async function probeScript(dir: string): Promise<string> {
  const out = join(dir, 'probe.cjs')
  const res = await build({
    stdin: { contents: PROBE, resolveDir: __dirname, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
  })
  writeFileSync(out, res.outputFiles[0].text)
  return out
}

type ProbeEnd = 'crash' | 'term' | 'kill'

function runProbe(script: string, mode: ProbeEnd): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, mode], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (mode !== 'crash' && chunk.toString().includes('ready')) {
        child.kill(mode === 'term' ? 'SIGTERM' : 'SIGKILL')
      }
    })
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : null)))
  })
}

describe('screens the extension created', () => {
  let fake: FakeScreens
  let dir: string
  const services: ScreensService[] = []
  const newService = (): ScreensService => {
    const service = new ScreensService()
    services.push(service)
    return service
  }

  beforeEach(() => {
    fake = fakeScreens()
    dir = mkdtempSync(join(tmpdir(), 'ostia-screens-probe-'))
  })

  afterEach(() => {
    for (const service of services.splice(0)) service.stopAllNow()
    fake.restore()
    rmSync(dir, { recursive: true, force: true })
  })

  it('SCX-C11 stops both screens of a workspace when it closes, and only those', async () => {
    const service = newService()
    await service.create({ workspaceId: 'A', allow: [] })
    await service.create({ workspaceId: 'A', allow: [] })
    await service.create({ workspaceId: 'B', allow: [] })
    await service.stopWorkspace('A')
    expect(fake.screens().map((s) => s.label)).toEqual(['workspace:B'])
    expect(service.registry.inWorkspace('A')).toEqual([])
  })

  it.each(['crash', 'term', 'kill'] as const)(
    'SCX-C12 stops its own screens and leaves another client screen when the extension ends (%s)',
    async (mode) => {
      const other = await runScreens<{ id: string }>({ args: ['create', '--label', 'mine'] })
      expect(other.ok).toBe(true)
      const code = await runProbe(await probeScript(dir), mode)
      expect(code).not.toBe(null)
      expect(fake.calls().filter((c) => c.startsWith('create'))).toHaveLength(1)
      expect(fake.calls().filter((c) => c.startsWith('daemon create --lease'))).toHaveLength(2)
      await expect.poll(() => fake.screens().map((s) => s.label)).toEqual(['mine'])
    },
  )

  it('forgets a screen that is gone from the service when it lists', async () => {
    const service = newService()
    const created = await service.create({ workspaceId: 'A', allow: [] })
    if (!created.ok) throw new Error(created.message)
    writeFileSync(join(fake.dir, 'state.json'), JSON.stringify({ screens: [] }))
    expect(await service.shown('A')).toEqual([])
    expect(service.registry.get(created.value.id)).toBeUndefined()
  })
})
