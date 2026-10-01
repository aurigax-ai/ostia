import { describe, expect, it } from 'vitest'
import { DEFAULT_ALLOW_READ, DEFAULT_CONTROLS } from '../../shared/sandbox'
import { buildSrtConfig, reachableContainerSockets, srtVendorDir } from './srtConfig'

const PACKAGED = '/opt/pine/resources/app.asar'
const VENDOR =
  '/opt/pine/resources/app.asar.unpacked/node_modules/@anthropic-ai/sandbox-runtime/vendor'

const paths = {
  home: '/home/u',
  workDir: '/home/u/app',
  tmpDir: '/tmp/sbx/w1',
  dataDirs: [],
  socketPath: '/run/pine.sock',
  runtimeReads: [],
}

describe('srtVendorDir', () => {
  it('points a packaged app at the unpacked copy, which bwrap can bind', () => {
    expect(srtVendorDir(PACKAGED)).toBe(VENDOR)
  })

  it('leaves an unpackaged app folder as it is', () => {
    expect(srtVendorDir('/home/u/pine')).toBe(
      '/home/u/pine/node_modules/@anthropic-ai/sandbox-runtime/vendor',
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
