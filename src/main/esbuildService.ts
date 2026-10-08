import { createRequire } from 'node:module'
import type { Transformer } from './artifactCompiler'

const BINARY_ENV = 'ESBUILD_BINARY_PATH'
const PACKED = 'app.asar'
const UNPACKED = 'app.asar.unpacked'

export function unpackedPath(path: string): string {
  return path.includes(UNPACKED) ? path : path.replace(PACKED, UNPACKED)
}

export function binaryPackage(platform: string, arch: string): string {
  const os = platform === 'win32' ? 'win32' : platform
  return `@esbuild/${os}-${arch}/bin/esbuild${platform === 'win32' ? '.exe' : ''}`
}

export async function loadEsbuild(packaged: boolean): Promise<Transformer> {
  if (packaged && !process.env[BINARY_ENV]) {
    const fromEsbuild = createRequire(createRequire(__filename).resolve('esbuild'))
    process.env[BINARY_ENV] = unpackedPath(
      fromEsbuild.resolve(binaryPackage(process.platform, process.arch)),
    )
  }
  return (await import('esbuild')) as unknown as Transformer
}
