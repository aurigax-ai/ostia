import { describe, expect, it } from 'vitest'
import { BINARY_ENV, binaryPackage, startEsbuild, unpackedPath } from './esbuildService'

const unused = async () =>
  ({
    outputFiles: [],
    errors: [],
    warnings: [],
    metafile: undefined,
    mangleCache: undefined,
  }) as never

describe('the packaged compiler', () => {
  it('runs the binary from outside the archive', () => {
    expect(
      unpackedPath('/opt/ostia/resources/app.asar/node_modules/@esbuild/linux-x64/bin/esbuild'),
    ).toBe('/opt/ostia/resources/app.asar.unpacked/node_modules/@esbuild/linux-x64/bin/esbuild')
    expect(unpackedPath('/x/app.asar.unpacked/node_modules/esbuild')).toBe(
      '/x/app.asar.unpacked/node_modules/esbuild',
    )
    expect(binaryPackage('linux', 'x64')).toBe('@esbuild/linux-x64/bin/esbuild')
    expect(binaryPackage('darwin', 'arm64')).toBe('@esbuild/darwin-arm64/bin/esbuild')
  })
})

describe('starting the compiler', () => {
  const UNPACKED =
    '/opt/ostia/resources/app.asar.unpacked/node_modules/@esbuild/linux-x64/bin/esbuild'

  it('uses the unpacked binary in a packaged app, ignores an inherited path, and leaves the environment as it was', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', [BINARY_ENV]: '/tmp/evil/esbuild' }
    const seen: (string | undefined)[] = []
    await startEsbuild({
      packaged: true,
      env,
      binary: () => UNPACKED,
      load: async () => ({
        context: unused,
        transform: async () => {
          seen.push(env[BINARY_ENV])
          return { code: '' }
        },
      }),
    })
    expect(seen).toEqual([UNPACKED])
    expect(env).toEqual({ PATH: '/bin', [BINARY_ENV]: '/tmp/evil/esbuild' })
  })

  it('never leaves its path in the environment panes and extensions inherit', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin' }
    await startEsbuild({
      packaged: true,
      env,
      binary: () => UNPACKED,
      load: async () => ({ context: unused, transform: async () => ({ code: '' }) }),
    })
    expect(BINARY_ENV in env).toBe(false)
    await expect(
      startEsbuild({
        packaged: true,
        env,
        binary: () => UNPACKED,
        load: async () => {
          throw new Error('missing')
        },
      }),
    ).rejects.toThrow('missing')
    expect(BINARY_ENV in env).toBe(false)
  })

  it('ignores an inherited path outside a package too', async () => {
    const env: NodeJS.ProcessEnv = { [BINARY_ENV]: '/tmp/evil/esbuild' }
    const seen: (string | undefined)[] = []
    await startEsbuild({
      packaged: false,
      env,
      load: async () => ({
        context: unused,
        transform: async () => {
          seen.push(env[BINARY_ENV])
          return { code: '' }
        },
      }),
    })
    expect(seen).toEqual([undefined])
    expect(env[BINARY_ENV]).toBe('/tmp/evil/esbuild')
  })
})
