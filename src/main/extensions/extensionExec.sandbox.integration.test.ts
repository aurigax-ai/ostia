import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_ALLOW_READ, DEFAULT_CONTROLS } from '../../shared/sandbox/sandbox'
import { SandboxHost, SandboxUnavailableError } from '../sandbox/hostClient'
import { buildSrtConfig } from '../sandbox/srtConfig'
import { ExtensionExec } from './extensionExec'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/ostia-test/sandbox-host-exec.mjs')

let root: string
let home: string
let workDir: string
let extData: string
let host: SandboxHost
let config: ReturnType<typeof buildSrtConfig>
let exec: ExtensionExec
let failWrap = false

beforeAll(async () => {
  await build({
    entryPoints: [join(repoRoot, 'src/main/sandbox/host.ts')],
    outfile: hostScript,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['@anthropic-ai/sandbox-runtime'],
  })
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-exec-sbx-')))
  home = join(root, 'home')
  workDir = join(home, 'proj')
  extData = join(home, '.config/ostia/extension-data')
  for (const d of [workDir, join(home, '.ssh'), join(extData, 'graphs/runs/x/out')])
    mkdirSync(d, { recursive: true })
  writeFileSync(join(home, '.ssh/config'), 'Host secret-box\n')
  writeFileSync(join(extData, 'graphs/enabled.json'), '{"enabled":["ENABLED-RECORD"]}')
  writeFileSync(join(extData, 'graphs/runs/x/out/input.txt'), 'READABLE-INPUT')
  config = buildSrtConfig(
    { allowRead: [...DEFAULT_ALLOW_READ], domains: [], controls: DEFAULT_CONTROLS },
    {
      home,
      workDir,
      tmpDir: join(root, 'tmp'),
      dataDirs: [extData],
      socketPath: join(root, 'ostia.sock'),
      runtimeReads: [],
    },
  )
  host = new SandboxHost({ nodePath: process.execPath, hostScript, onAsk: async () => false })
  await host.start(config)
  exec = new ExtensionExec({
    workspace: (id) => (id === 'sb' ? { workDir, sandboxed: true } : null),
    wrap: async (_id, command, extraReads) => {
      if (failWrap) throw new SandboxUnavailableError('bwrap is not installed')
      return host.wrap(command, 'bash', {
        filesystem: {
          ...config.filesystem,
          allowRead: [...(config.filesystem.allowRead ?? []), ...extraReads],
        },
      })
    },
    sandboxEnv: (_id, env) => env,
    dataDir: (extId) => join(extData, extId),
    baseEnv: () => ({ PATH: '/usr/bin:/bin', HOME: home }),
  })
}, 60_000)

afterAll(() => {
  exec?.stopAll()
  host?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

const sh = (script: string, extra: Record<string, unknown> = {}) =>
  exec.run('graphs', {
    workspaceId: 'sb',
    command: ['sh', '-c', script],
    timeoutMs: 20_000,
    ...extra,
  })

describe('ext.exec in a sandboxed workspace', () => {
  it('GRF-C92 a command node is held to the workspace sandbox: no ~/.ssh, no writes outside', async () => {
    const read = await sh(`cat ${home}/.ssh/config`)
    expect(read).toMatchObject({ ok: true, sandboxed: true })
    expect((read as { exitCode: number }).exitCode).not.toBe(0)
    expect((read as { stdout: string }).stdout).not.toContain('secret-box')
    const outside = join(root, 'outside.txt')
    const write = await sh(`echo x > ${outside}`)
    expect((write as { exitCode: number }).exitCode).not.toBe(0)
    expect(existsSync(outside)).toBe(false)
  })

  it('GRF-C95 a sandboxed command can neither read nor write the extension data folder', async () => {
    const read = await sh(`cat ${extData}/graphs/enabled.json`)
    expect((read as { stdout: string }).stdout).not.toContain('ENABLED-RECORD')
    await sh(`echo '{"enabled":["forged"]}' > ${extData}/graphs/enabled.json`)
    expect(readFileSync(join(extData, 'graphs/enabled.json'), 'utf8')).toContain('ENABLED-RECORD')
  })

  it('GRF-C111 dataDir is shown read-only as OSTIA_EXEC_DIR', async () => {
    const res = await sh(
      'cat "$OSTIA_EXEC_DIR/input.txt"; echo changed > "$OSTIA_EXEC_DIR/input.txt"',
      { dataDir: 'runs/x/out' },
    )
    expect(res).toMatchObject({ ok: true, sandboxed: true })
    expect((res as { stdout: string }).stdout).toContain('READABLE-INPUT')
    expect(readFileSync(join(extData, 'graphs/runs/x/out/input.txt'), 'utf8')).toBe(
      'READABLE-INPUT',
    )
  })

  it('GRF-C93 a sandbox that cannot start refuses the command and nothing runs unwrapped', async () => {
    failWrap = true
    const marker = join(workDir, 'ran-unwrapped')
    expect(await sh(`touch ${marker}`)).toMatchObject({ ok: false, error: 'sandbox-unavailable' })
    expect(existsSync(marker)).toBe(false)
    failWrap = false
  })
})
