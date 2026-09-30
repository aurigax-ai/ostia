import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONTROLS } from '../../shared/sandbox'
import { SandboxHost } from './hostClient'
import { buildSrtConfig } from './srtConfig'

const repoRoot = process.cwd()

describe('sandboxed servers on macOS', () => {
  it('SBX-C58 lets a sandboxed server bind loopback and refuses 0.0.0.0', async (ctx) => {
    if (process.platform !== 'darwin') ctx.skip()
    const hostScript = join(repoRoot, 'node_modules/.cache/pine-test/sandbox-host-mac.mjs')
    await build({
      entryPoints: [join(repoRoot, 'src/main/sandbox/host.ts')],
      outfile: hostScript,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
    })
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-mac-ports-')))
    const workDir = join(root, 'home', 'proj')
    mkdirSync(workDir, { recursive: true })
    const host = new SandboxHost({
      nodePath: process.execPath,
      hostScript,
      onAsk: async () => false,
    })
    try {
      await host.start(
        buildSrtConfig(
          { allowRead: [], domains: [], controls: DEFAULT_CONTROLS },
          {
            home: join(root, 'home'),
            workDir,
            tmpDir: join(root, 'tmp'),
            dataDirs: [],
            socketPath: join(root, 'pine.sock'),
            runtimeReads: [],
          },
          'darwin',
        ),
      )
      const probe = (address: string) =>
        `${process.execPath} -e "require('net').createServer().listen(0,'${address}',function(){console.log('BOUND');this.close()}).on('error',e=>console.log('ERR',e.code))"`
      const run = async (address: string) =>
        execFileSync('/bin/sh', ['-c', await host.wrap(probe(address), 'bash')], {
          cwd: workDir,
          encoding: 'utf8',
        })
      expect(await run('127.0.0.1')).toContain('BOUND')
      expect(await run('0.0.0.0')).not.toContain('BOUND')
    } finally {
      host.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
