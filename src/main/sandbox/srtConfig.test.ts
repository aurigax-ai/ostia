import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DEFAULT_ALLOW_READ, DEFAULT_CONTROLS } from '../../shared/sandbox'
import {
  HOME_HIDDEN_FILES,
  buildSrtConfig,
  canBlockSockets,
  fixedPolicy,
  folderProblem,
  reachableContainerSockets,
  srtVendorDir,
} from './srtConfig'

const PACKAGED = '/opt/ostia/resources/app.asar'
const VENDOR =
  '/opt/ostia/resources/app.asar.unpacked/node_modules/@anthropic-ai/sandbox-runtime/vendor'

const paths = {
  home: '/home/u',
  workDir: '/home/u/app',
  tmpDir: '/tmp/sbx/w1',
  dataDirs: [],
  socketPath: '/run/ostia.sock',
  runtimeReads: [],
}

describe('srtVendorDir', () => {
  it('points a packaged app at the unpacked copy, which bwrap can bind', () => {
    expect(srtVendorDir(PACKAGED)).toBe(VENDOR)
  })

  it('leaves an unpackaged app folder as it is', () => {
    expect(srtVendorDir('/home/u/ostia')).toBe(
      '/home/u/ostia/node_modules/@anthropic-ai/sandbox-runtime/vendor',
    )
  })
})

describe('buildSrtConfig default read paths', () => {
  it('lets the shell rc read its colour-theme configs while the rest of home stays hidden', () => {
    const policy = { allowRead: DEFAULT_ALLOW_READ, domains: [], controls: DEFAULT_CONTROLS }
    const { filesystem } = buildSrtConfig(policy, paths, 'linux', 'x64')
    expect(filesystem.denyRead).toContain('/home/u')
    expect(filesystem.allowRead).toEqual(
      expect.arrayContaining(['/home/u/.zshrc', '/home/u/.config/vivid', '/home/u/.config/bat']),
    )
    expect(filesystem.allowRead).not.toContain('/home/u/.config')
    expect(filesystem.allowWrite).not.toContain('/home/u/.config/vivid')
  })
})

describe('container sockets', () => {
  it('lists only the sockets this user can connect to, once per real path', () => {
    const reachable = (path: string): boolean => path.endsWith('docker.sock')
    const resolve = (path: string): string => path.replace('/var/run/', '/run/')
    expect(reachableContainerSockets(reachable, resolve)).toEqual(['/run/docker.sock'])
    expect(reachableContainerSockets(() => false, resolve)).toEqual([])
  })

  it('hides the reachable ones from the sandbox, since Docker would hand out the host', () => {
    const policy = { allowRead: [], domains: [], controls: DEFAULT_CONTROLS }
    const { filesystem } = buildSrtConfig(
      policy,
      { ...paths, containerSockets: ['/run/docker.sock'] },
      'linux',
      'x64',
    )
    expect(filesystem.denyRead).toContain('/run/docker.sock')
    expect(filesystem.allowRead).not.toContain('/run/docker.sock')
  })
})

describe('buildSrtConfig vendored binaries', () => {
  const policy = { allowRead: [], domains: [], controls: DEFAULT_CONTROLS }

  it('hands srt the unpacked java agent and apply-seccomp on Linux', () => {
    const config = buildSrtConfig(policy, { ...paths, srtVendorDir: VENDOR }, 'linux', 'x64')
    expect(config.javaAgentJarPath).toBe(`${VENDOR}/java-proxy-agent/srt-proxy-agent.jar`)
    expect(config.seccomp).toEqual({ applyPath: `${VENDOR}/seccomp/x64/apply-seccomp` })
  })

  it('gives macOS only the java agent', () => {
    const config = buildSrtConfig(policy, { ...paths, srtVendorDir: VENDOR }, 'darwin', 'arm64')
    expect(config.javaAgentJarPath).toBe(`${VENDOR}/java-proxy-agent/srt-proxy-agent.jar`)
    expect(config.seccomp).toBeUndefined()
  })
})

const guardedPaths = {
  ...paths,
  dataDirs: ['/home/u/.local/share/ostia', '/home/u/.config/ostia'],
  runtimeDir: '/run/user/1000',
  socketPath: '/run/user/1000/ostia-1.sock',
  agentSockets: ['/tmp/ssh-abc/agent.1'],
  containerSockets: ['/run/docker.sock'],
  tmpRoot: '/tmp/ostia-sandbox',
}

describe('buildSrtConfig filesystem limits', () => {
  it('makes a writable folder the human added writable and readable, next to the fixed ones', () => {
    const policy = { allowRead: [], domains: [], allowWrite: ['~/builds', '/srv/out'] }
    const { filesystem } = buildSrtConfig(policy, guardedPaths, 'linux', 'x64')
    expect(filesystem.allowWrite).toEqual([
      '/home/u/app',
      '/tmp/sbx/w1',
      '/home/u/.claude',
      '/home/u/.codex',
      '/home/u/builds',
      '/srv/out',
    ])
    expect(filesystem.allowRead).toEqual(expect.arrayContaining(['/home/u/builds', '/srv/out']))
  })

  it('hides the paths the human listed and drops any readable or writable entry beneath them', () => {
    const policy = {
      allowRead: ['~/.cargo', '~/.cargo/registry', '~/notes'],
      allowWrite: ['~/.cargo/target'],
      denyRead: ['~/.cargo', '/home/u/app/secrets'],
      domains: [],
    }
    const { filesystem } = buildSrtConfig(policy, guardedPaths, 'linux', 'x64')
    expect(filesystem.denyRead).toEqual(
      expect.arrayContaining(['/home/u', '/home/u/.cargo', '/home/u/app/secrets']),
    )
    expect(filesystem.allowRead).toContain('/home/u/notes')
    expect(filesystem.allowRead).toContain('/home/u/app')
    expect(filesystem.allowRead?.some((p) => p.startsWith('/home/u/.cargo'))).toBe(false)
    expect(filesystem.allowWrite.some((p) => p.startsWith('/home/u/.cargo'))).toBe(false)
  })

  it('stops handing the agent folder to the sandbox once the human hides it', () => {
    const policy = { allowRead: [], domains: [], denyRead: ['~/.claude'] }
    const { filesystem } = buildSrtConfig(policy, guardedPaths, 'linux', 'x64')
    expect(filesystem.allowRead).not.toContain('/home/u/.claude')
    expect(filesystem.allowWrite).not.toContain('/home/u/.claude')
    expect(filesystem.allowWrite).toContain('/home/u/.codex')
  })

  it('adds read-only paths after the fixed ones, which the runtime puts above every writable path', () => {
    const policy = { allowRead: [], domains: [], denyWrite: ['~/app/dist', '/srv/out/keep'] }
    const { filesystem } = buildSrtConfig(policy, guardedPaths, 'linux', 'x64')
    expect(filesystem.denyWrite).toEqual(
      expect.arrayContaining([
        '/home/u/.claude/settings.json',
        '/home/u/app/.git/hooks',
        '/home/u/app/dist',
        '/srv/out/keep',
      ]),
    )
  })

  it('never opens Ostia data, the socket folder, an agent socket folder, a container socket or another sandbox tmp', () => {
    const closed = [
      '/home/u/.local/share/ostia',
      '/home/u/.local/share/ostia/vault.json',
      '/home/u/.local/share',
      '/home/u/.config/ostia/settings.json',
      '/run/user/1000',
      '/run/user/1000/bus',
      '/run',
      '/tmp/ssh-abc',
      '/tmp/ssh-abc/agent.1',
      '/run/docker.sock',
      '/tmp/ostia-sandbox',
      '/tmp/ostia-sandbox/other-workspace',
      '/tmp',
    ]
    const policy = { allowRead: closed, allowWrite: closed, allowSockets: closed, domains: [] }
    for (const platform of ['linux', 'darwin'] as const) {
      const { filesystem, network } = buildSrtConfig(policy, guardedPaths, platform, 'x64')
      for (const path of closed) {
        expect(filesystem.allowWrite).not.toContain(path)
        expect(filesystem.allowRead).not.toContain(path)
        expect(network.allowUnixSockets ?? []).not.toContain(path)
      }
      expect(filesystem.denyRead).toEqual(
        expect.arrayContaining([
          '/home/u/.local/share/ostia',
          '/run/user/1000',
          '/tmp/ssh-abc',
          '/run/docker.sock',
          '/tmp/ostia-sandbox',
        ]),
      )
    }
  })

  it('keeps the protected agent and git files read-only even when the human lists them as writable', () => {
    const policy = {
      allowRead: [],
      domains: [],
      allowWrite: ['~/.claude/settings.json', '/home/u/app/.git/hooks'],
    }
    const { filesystem } = buildSrtConfig(policy, guardedPaths, 'linux', 'x64')
    expect(filesystem.denyWrite).toEqual(
      expect.arrayContaining(['/home/u/.claude/settings.json', '/home/u/app/.git/hooks']),
    )
  })
})

describe('buildSrtConfig through a symlink', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-srtconfig-')))
  const home = join(root, 'home')
  const dataDir = join(home, '.local/share/ostia')
  mkdirSync(dataDir, { recursive: true })
  symlinkSync(dataDir, join(home, 'innocent'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('drops a readable or writable entry whose real path is inside Ostia data', () => {
    const { filesystem } = buildSrtConfig(
      { allowRead: ['~/innocent'], allowWrite: ['~/innocent'], domains: [] },
      { ...paths, home, workDir: join(home, 'app'), dataDirs: [dataDir] },
      'linux',
      'x64',
    )
    expect(filesystem.allowRead).not.toContain(join(home, 'innocent'))
    expect(filesystem.allowWrite).not.toContain(join(home, 'innocent'))
  })
})

describe('buildSrtConfig Unix sockets', () => {
  const base = { allowRead: [], domains: [] }
  const on = { unixSockets: true, gitConfig: false, strictDomains: false }
  const off = { ...on, unixSockets: false }

  it('allows every Unix socket on Linux by default, where the runtime cannot filter by path', () => {
    const { network } = buildSrtConfig(base, guardedPaths, 'linux', 'x64')
    expect(network.allowAllUnixSockets).toBe(true)
    expect(network.allowUnixSockets).toBeUndefined()
  })

  it('blocks every Unix socket on Linux when the human turns them off', () => {
    const { network } = buildSrtConfig({ ...base, switches: off }, guardedPaths, 'linux', 'x64')
    expect(network.allowAllUnixSockets).toBe(false)
  })

  it('ignores the allowed socket list on Linux', () => {
    const { network } = buildSrtConfig(
      { ...base, switches: on, allowSockets: ['/var/run/tool.sock'] },
      guardedPaths,
      'linux',
      'x64',
    )
    expect(network.allowUnixSockets).toBeUndefined()
  })

  it("allows only Ostia's socket and the listed sockets on macOS", () => {
    const { network } = buildSrtConfig(
      { ...base, switches: on, allowSockets: ['/var/run/tool.sock', '~/run/app.sock'] },
      guardedPaths,
      'darwin',
      'arm64',
    )
    expect(network.allowAllUnixSockets).toBeUndefined()
    expect(network.allowUnixSockets).toEqual([
      '/run/user/1000/ostia-1.sock',
      '/tmp/sbx/w1/a.sock',
      '/var/run/tool.sock',
      '/home/u/run/app.sock',
    ])
  })

  it("blocks every Unix socket on macOS, Ostia's included, when the human turns them off", () => {
    const { network } = buildSrtConfig(
      { ...base, switches: off, allowSockets: ['/var/run/tool.sock'] },
      guardedPaths,
      'darwin',
      'arm64',
    )
    expect(network.allowUnixSockets).toEqual([])
    expect(network.allowAllUnixSockets).toBeUndefined()
  })

  it('says socket blocking works only where the runtime ships a filter', () => {
    expect(canBlockSockets('linux', 'x64')).toBe(true)
    expect(canBlockSockets('linux', 'arm64')).toBe(true)
    expect(canBlockSockets('linux', 'riscv64')).toBe(false)
    expect(canBlockSockets('darwin', 'arm64')).toBe(true)
  })
})

describe('buildSrtConfig network and git options', () => {
  const base = { allowRead: [], domains: ['example.com'] }

  it('passes blocked domains to the runtime, which checks them before the allowed ones', () => {
    const { network } = buildSrtConfig(
      { ...base, deniedDomains: ['telemetry.example.com'] },
      paths,
      'linux',
      'x64',
    )
    expect(network.deniedDomains).toEqual(['telemetry.example.com'])
    expect(network.allowedDomains).toEqual(['example.com'])
  })

  it('asks about unlisted domains by default and refuses them outright when the human says never ask', () => {
    expect(buildSrtConfig(base, paths, 'linux', 'x64').network.strictAllowlist).toBe(false)
    const strict = { unixSockets: true, gitConfig: false, strictDomains: true }
    expect(
      buildSrtConfig({ ...base, switches: strict }, paths, 'linux', 'x64').network.strictAllowlist,
    ).toBe(true)
  })

  it('keeps .git/config read-only until the human lets git change it, and hooks read-only always', () => {
    const closed = buildSrtConfig(base, paths, 'linux', 'x64').filesystem
    expect(closed.allowGitConfig).toBe(false)
    expect(closed.denyWrite).toContain('/home/u/app/.git/config')
    const git = { unixSockets: true, gitConfig: true, strictDomains: false }
    const open = buildSrtConfig({ ...base, switches: git }, paths, 'linux', 'x64').filesystem
    expect(open.allowGitConfig).toBe(true)
    expect(open.denyWrite).not.toContain('/home/u/app/.git/config')
    expect(open.denyWrite).toContain('/home/u/app/.git/hooks')
  })
})

describe('fixedPolicy', () => {
  const git = { gitConfig: false }

  it('lists what Ostia always hides, opens and protects for a workspace', () => {
    const fixed = fixedPolicy(
      guardedPaths,
      { workDir: '/home/u/app', tmpDir: '/tmp/sbx/w1' },
      git,
      'linux',
      'x64',
    )
    expect(fixed.hidden).toEqual([
      '/home/u',
      '/home/u/.local/share/ostia',
      '/home/u/.config/ostia',
      '/home/u/.cargo/credentials.toml',
      '/home/u/.cargo/credentials',
      '/home/u/app/.ostia/vault.json',
      '/home/u/app/.pine/vault.json',
      '/tmp/ssh-abc',
      '/run/docker.sock',
      '/run/user/1000',
      '/tmp/ostia-sandbox',
    ])
    expect(fixed.readable).toEqual([
      '/home/u/app',
      '/tmp/sbx/w1',
      '/run/user/1000/ostia-1.sock',
      '/home/u/.claude',
      '/home/u/.codex',
    ])
    expect(fixed.writable).toEqual([
      '/home/u/app',
      '/tmp/sbx/w1',
      '/home/u/.claude',
      '/home/u/.codex',
    ])
    expect(fixed.readOnly).toContain('/home/u/app/.git/config')
    expect(fixed.hiddenSockets).toEqual(['/tmp/ssh-abc', '/run/docker.sock'])
    expect(fixed.socketBlocking).toBe(true)
  })

  it('matches what buildSrtConfig hands the runtime when the human added nothing', () => {
    const fixed = fixedPolicy(
      guardedPaths,
      { workDir: '/home/u/app', tmpDir: '/tmp/sbx/w1' },
      git,
      'linux',
      'x64',
    )
    const { filesystem } = buildSrtConfig(
      { allowRead: [], domains: [] },
      guardedPaths,
      'linux',
      'x64',
    )
    expect(filesystem.denyRead).toEqual(fixed.hidden)
    expect(filesystem.allowRead).toEqual(fixed.readable)
    expect(filesystem.allowWrite).toEqual(fixed.writable)
    expect(filesystem.denyWrite).toEqual(fixed.readOnly)
  })

  it('keeps ~/.cargo readable from the defaults but always hides its credentials', () => {
    const { filesystem } = buildSrtConfig(
      { allowRead: DEFAULT_ALLOW_READ, domains: [] },
      guardedPaths,
      'linux',
      'x64',
    )
    expect(filesystem.allowRead).toContain('/home/u/.cargo')
    expect(filesystem.denyRead).toEqual(
      expect.arrayContaining(['/home/u/.cargo/credentials.toml', '/home/u/.cargo/credentials']),
    )
    expect(HOME_HIDDEN_FILES).toEqual(['.cargo/credentials.toml', '.cargo/credentials'])
  })

  it('leaves out the workspace paths when no workspace is named', () => {
    const fixed = fixedPolicy(guardedPaths, null, git, 'linux', 'x64')
    expect(fixed.readable).toEqual([
      '/run/user/1000/ostia-1.sock',
      '/home/u/.claude',
      '/home/u/.codex',
    ])
    expect(fixed.writable).toEqual(['/home/u/.claude', '/home/u/.codex'])
    expect(fixed.readOnly.some((p) => p.includes('.git'))).toBe(false)
  })
})

describe('folderProblem', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-folder-problem-')))
  const home = join(base, 'u')
  const homePaths = {
    ...guardedPaths,
    home,
    dataDirs: [join(home, '.local/share/ostia'), join(home, '.config/ostia')],
  }
  mkdirSync(join(home, '.local/share/ostia'), { recursive: true })
  mkdirSync(join(home, '.config/ostia/extensions'), { recursive: true })
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  it('refuses the home folder, a folder above it and one that holds Ostia data', () => {
    expect(folderProblem(home, homePaths)).toBe('home')
    expect(folderProblem(`${home}/`, homePaths)).toBe('home')
    expect(folderProblem(base, homePaths)).toBe('above-home')
    expect(folderProblem('/', homePaths)).toBe('above-home')
    expect(folderProblem(join(home, '.local'), homePaths)).toBe('ostia-data')
    expect(folderProblem(join(home, '.config/ostia/extensions'), homePaths)).toBe('ostia-data')
  })

  it('accepts a project folder inside or outside home', () => {
    expect(folderProblem('/home/u/app', guardedPaths)).toBeNull()
    expect(folderProblem('/srv/project', guardedPaths)).toBeNull()
  })
})
