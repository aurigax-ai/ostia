import { createRequire } from 'node:module'
import type { Bundler } from './portableBundle'

interface Esbuild extends Bundler {
  transform: (source: string, options: Record<string, unknown>) => Promise<unknown>
}

export const BINARY_ENV = 'ESBUILD_BINARY_PATH'
const PACKED = 'app.asar'
const UNPACKED = 'app.asar.unpacked'

export function unpackedPath(path: string): string {
  return path.includes(UNPACKED) ? path : path.replace(PACKED, UNPACKED)
}

export function binaryPackage(platform: string, arch: string): string {
  return `@esbuild/${platform}-${arch}/bin/esbuild${platform === 'win32' ? '.exe' : ''}`
}

function packagedBinary(): string {
  const fromEsbuild = createRequire(createRequire(__filename).resolve('esbuild'))
  return unpackedPath(fromEsbuild.resolve(binaryPackage(process.platform, process.arch)))
}

interface EsbuildLoad {
  packaged: boolean
  env?: NodeJS.ProcessEnv
  binary?: () => string
  load?: () => Promise<Esbuild>
}

export async function startEsbuild(options: EsbuildLoad): Promise<Esbuild> {
  const env = options.env ?? process.env
  const inherited = env[BINARY_ENV]
  if (options.packaged) env[BINARY_ENV] = (options.binary ?? packagedBinary)()
  else delete env[BINARY_ENV]
  try {
    const load = options.load ?? (async () => (await import('esbuild')) as unknown as Esbuild)
    const esbuild = await load()
    await esbuild.transform('', { loader: 'js' })
    return esbuild
  } finally {
    if (inherited === undefined) delete env[BINARY_ENV]
    else env[BINARY_ENV] = inherited
  }
}

let started: Promise<Bundler> | null = null

export function loadEsbuild(packaged: boolean): Promise<Bundler> {
  started ??= startEsbuild({ packaged }).then(
    (esbuild) => ({
      build: (options) => esbuild.build(options),
      stop: () => {
        started = null
        return esbuild.stop?.()
      },
    }),
    (error) => {
      started = null
      throw error
    },
  )
  return started
}
