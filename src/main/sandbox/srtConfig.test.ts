import { describe, expect, it } from 'vitest'
import { DEFAULT_CONTROLS } from '../../shared/sandbox'
import { buildSrtConfig, srtVendorDir } from './srtConfig'

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
