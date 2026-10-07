import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { type Server, createServer as createHttpServer } from 'node:http'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONTROLS } from '../../shared/sandbox'
import { SandboxHost } from './hostClient'
import { buildSrtConfig } from './srtConfig'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/ostia-test/sandbox-host.mjs')

let root: string
let home: string
let workDir: string
let tmpDir: string
let dataDir: string
let runtimeDir: string
let socketPath: string
let host: SandboxHost
let asks: string[]
let origin: Server
let originPort: number
const originHosts: string[] = []

function contents(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function run(
  script: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; out: string }> {
  return host.wrap(script, 'bash').then(
    (wrapped) =>
      new Promise((resolve) => {
        const child = spawn('/bin/sh', ['-c', wrapped], { cwd: workDir, env: { ...env } })
        let out = ''
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString('utf8')
        })
        child.stderr.on('data', (d: Buffer) => {
          out += d.toString('utf8')
        })
        child.on('close', (code) => resolve({ code: code ?? -1, out }))
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
    packages: 'external',
  })
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-sbx-')))
  home = join(root, 'home')
  workDir = join(home, 'proj')
  tmpDir = join(root, 'wstmp')
  dataDir = join(home, '.local/share/ostia')
  runtimeDir = join(root, 'run')
  for (const d of [
    workDir,
    tmpDir,
    dataDir,
    runtimeDir,
    join(home, '.ssh'),
    join(home, '.claude'),
  ]) {
    mkdirSync(d, { recursive: true })
  }
  writeFileSync(join(home, '.ssh/id_ed25519'), 'PRIVATE')
  writeFileSync(join(home, '.zshrc'), 'export RC=1')
  writeFileSync(join(home, 'other.txt'), 'OTHER-PROJECT')
  writeFileSync(join(dataDir, 'vault.json'), '{}')
  mkdirSync(join(workDir, '.pine'), { recursive: true })
  writeFileSync(join(workDir, '.pine/vault.json'), '{"K":"cipher"}')
  mkdirSync(join(workDir, '.ostia'), { recursive: true })
  writeFileSync(join(workDir, '.ostia/vault.json'), '{"K":"newcipher"}')
  writeFileSync(join(workDir, 'readme.txt'), 'hello')
  socketPath = join(runtimeDir, 'ostia.sock')
  await new Promise<void>((resolve) => createServer().listen(socketPath, resolve))
  writeFileSync(join(runtimeDir, 'bus'), '')
  origin = createHttpServer((req, res) => {
    originHosts.push(String(req.headers.host).split(':')[0])
    res.end('ORIGIN-REACHED')
  })
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
  originPort = (origin.address() as AddressInfo).port
  asks = []
  host = new SandboxHost({
    nodePath: process.execPath,
    hostScript,
    onAsk: async (h) => {
      asks.push(h)
      return false
    },
  })
  await host.start(
    buildSrtConfig(
      {
        allowRead: ['~/.zshrc'],
        domains: ['allowed.localhost'],
        controls: DEFAULT_CONTROLS,
      },
      {
        home,
        workDir,
        tmpDir,
        dataDirs: [dataDir],
        runtimeDir,
        socketPath,
        runtimeReads: [],
      },
    ),
  )
}, 60_000)

afterAll(() => {
  host?.stop()
  origin?.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('sandbox runtime', () => {
  it('SBX-C22 denies reads of ~/.ssh and other folders under home', async () => {
    const res = await run(
      `cat ${home}/.ssh/id_ed25519; cat ${home}/other.txt; cat ${dataDir}/vault.json; echo done`,
    )
    expect(res.out).not.toContain('PRIVATE')
    expect(res.out).not.toContain('OTHER-PROJECT')
    expect(res.out).toContain('done')
  })

  it('SBX-C28 writes only the workDir and the private tmp', async () => {
    rmSync('/tmp/ostia-sbx-escape.txt', { force: true })
    const res = await run(
      `echo a > ${workDir}/w.txt && echo ok1; echo b > ${tmpDir}/t.txt && echo ok2; echo c > /tmp/ostia-sbx-escape.txt && echo bad1; echo d > ${home}/x.txt && echo bad2; true`,
    )
    expect(res.out).toContain('ok1')
    expect(res.out).toContain('ok2')
    expect(existsSync('/tmp/ostia-sbx-escape.txt')).toBe(false)
    expect(existsSync(join(home, 'x.txt'))).toBe(false)
  })

  it('SBX-C30 denies writes to agent settings and hooks', async () => {
    await run(
      `echo x > ${home}/.claude/settings.json; mkdir -p ${home}/.claude/hooks; echo x > ${home}/.claude/hooks/h; echo s > ${home}/.claude/session.jsonl; true`,
    )
    expect(contents(join(home, '.claude/settings.json'))).not.toContain('x')
    expect(contents(join(home, '.claude/hooks/h'))).not.toContain('x')
    expect(existsSync(join(home, '.claude/session.jsonl'))).toBe(true)
  })

  it('SBX-C32 protects git hooks right after git init inside the sandbox', async () => {
    const res = await run(
      `cd ${workDir} && git init -q . ; echo evil > .git/hooks/pre-commit; echo evil > .envrc; ls -la .git .git/hooks; true`,
    )
    expect(contents(join(workDir, '.git/hooks/pre-commit'))).not.toContain('evil')
    expect(contents(join(workDir, '.envrc'))).not.toContain('evil')
    expect(res.code).toBe(0)
  })

  it('SBX-C62 hides the project vault from the sandbox, in .ostia and the older .pine', async () => {
    const res = await run(
      `cat ${workDir}/.ostia/vault.json ${workDir}/.pine/vault.json; rm -f ${workDir}/.ostia/vault.json ${workDir}/.pine/vault.json; true`,
    )
    expect(res.out).not.toContain('cipher')
    expect(existsSync(join(workDir, '.ostia/vault.json'))).toBe(true)
    expect(existsSync(join(workDir, '.pine/vault.json'))).toBe(true)
  })

  it('SBX-C35 reaches allowed hosts and blocks the rest', async () => {
    const res = await run(
      `env -u NO_PROXY -u no_proxy curl -s -m 20 -w "|allowed=%{http_code}\\n" http://allowed.localhost:${originPort}/; env -u NO_PROXY -u no_proxy curl -s -m 20 -o /dev/null -w "blocked=%{http_code}\\n" http://blocked.localhost:${originPort}/; true`,
    )
    expect(res.out).toContain('ORIGIN-REACHED|allowed=200')
    expect(res.out).toContain('blocked=403')
    expect(asks).toContain('blocked.localhost')
    expect(originHosts).toContain('allowed.localhost')
    expect(originHosts).not.toContain('blocked.localhost')
  }, 60_000)

  it("reaches the proxy on a command's first connection even when the relays start slowly", async () => {
    const slowBin = join(root, 'slow-socat')
    mkdirSync(slowBin)
    const realSocat = execFileSync('/bin/sh', ['-c', 'command -v socat'], {
      encoding: 'utf8',
    }).trim()
    writeFileSync(join(slowBin, 'socat'), `#!/bin/sh\nsleep 0.1\nexec ${realSocat} "$@"\n`)
    chmodSync(join(slowBin, 'socat'), 0o755)
    const res = await run(
      `env -u NO_PROXY -u no_proxy curl -s -m 20 -w "|first=%{http_code}\\n" http://allowed.localhost:${originPort}/`,
      { ...process.env, PATH: `${slowBin}:${process.env.PATH}` },
    )
    expect(res.out).toContain('ORIGIN-REACHED|first=200')
  }, 60_000)

  it('SBX-C55 keeps other unix sockets out of reach while the ostia socket works', async () => {
    const res = await run(
      `node -e "require('net').connect('${socketPath}').on('connect',()=>{console.log('ostia-ok');process.exit(0)}).on('error',e=>{console.log('ostia-err',e.code);process.exit(0)})"; ls ${runtimeDir}`,
    )
    expect(res.out).toContain('ostia-ok')
    expect(res.out).not.toContain('bus')
  })
})
