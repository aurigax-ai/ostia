import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONTROLS } from '../../shared/sandbox/sandbox'
import { SandboxHost } from './hostClient'
import { linkPluginsFarm } from './pluginsFarm'
import { buildSrtConfig } from './srtConfig'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/ostia-test/sandbox-host-plugin-data.mjs')

let root: string
let workDir: string
let realPlugins: string
let farm: string
let data: string
let host: SandboxHost

function run(script: string): Promise<string> {
  return host.wrap(script, 'bash').then(
    (wrapped) =>
      new Promise((resolve) => {
        const child = spawn('/bin/sh', ['-c', wrapped], { cwd: workDir, env: { ...process.env } })
        let out = ''
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString('utf8')
        })
        child.stderr.on('data', (d: Buffer) => {
          out += d.toString('utf8')
        })
        child.on('close', () => resolve(out))
      }),
  )
}

beforeAll(async () => {
  await build({
    entryPoints: [join(repoRoot, 'src/main/sandbox/host.ts')],
    outfile: hostScript,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['@anthropic-ai/sandbox-runtime'],
  })
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-sbx-plugins-')))
  const home = join(root, 'home')
  workDir = join(home, 'proj')
  realPlugins = join(home, '.claude/plugins')
  farm = join(root, 'tmp', 'w1-plugins')
  data = join(root, 'tmp', 'w1', 'plugin-data')
  mkdirSync(workDir, { recursive: true })
  mkdirSync(join(realPlugins, 'data/codex/state'), { recursive: true })
  mkdirSync(join(realPlugins, 'cache'), { recursive: true })
  writeFileSync(join(realPlugins, 'installed_plugins.json'), '{"plugins":[]}')
  linkPluginsFarm(farm, data, realPlugins)
  host = new SandboxHost({ nodePath: process.execPath, hostScript, onAsk: async () => false })
  await host.start(
    buildSrtConfig(
      { allowRead: [], domains: [], controls: DEFAULT_CONTROLS },
      {
        home,
        workDir,
        tmpDir: join(root, 'tmp', 'w1'),
        pluginsDir: farm,
        tmpRoot: join(root, 'tmp'),
        dataDirs: [join(home, '.local/share/ostia')],
        socketPath: join(root, 'ostia.sock'),
        runtimeReads: [],
      },
    ),
  )
}, 60_000)

afterAll(() => {
  host?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('plugin data in a sandbox', () => {
  it('lets a plugin write its state into the sandbox own data folder and nowhere else', async () => {
    const state = join(data, 'codex/state/ws/jobs')
    const out = await run(
      `mkdir -p ${farm}/data/codex/state/ws/jobs && echo job > ${farm}/data/codex/state/ws/jobs/1.json; echo own=$?; mkdir ${realPlugins}/data/codex/state/ws; echo real=$?; touch ${farm}/evil; echo farmroot=$?; touch ${farm}/cache/evil; echo code=$?; cat ${farm}/installed_plugins.json`,
    )
    expect(out).toContain('own=0')
    expect(out).toContain('real=1')
    expect(out).toContain('farmroot=1')
    expect(out).toContain('code=1')
    expect(out).toContain('{"plugins":[]}')
    expect(readFileSync(join(state, '1.json'), 'utf8')).toBe('job\n')
    expect(readdirSync(join(realPlugins, 'data/codex/state'))).toEqual([])
    expect(readdirSync(join(realPlugins, 'cache'))).toEqual([])
    expect(existsSync(join(farm, 'evil'))).toBe(false)
  })
})
