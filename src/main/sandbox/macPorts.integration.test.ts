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
  it.skipIf(process.platform !== 'darwin')(
    'SBX-C58 (macOS only: Seatbelt) lets a sandboxed server bind loopback, and cannot hold it to loopback',
    async () => {
      const hostScript = join(repoRoot, 'node_modules/.cache/ostia-test/sandbox-host-mac.mjs')
      await build({
        entryPoints: [join(repoRoot, 'src/main/sandbox/host.ts')],
        outfile: hostScript,
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
      })
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-mac-ports-')))
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
              socketPath: join(root, 'ostia.sock'),
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
        expect(await run('0.0.0.0')).toContain('BOUND')
      } finally {
        host.stop()
        rmSync(root, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
