import * as nodeFs from 'node:fs'
import { createRequire } from 'node:module'

type Fs = typeof nodeFs

function plainFs(): Fs {
  if (!process.versions.electron) return nodeFs
  return createRequire(process.execPath)('original-fs') as Fs
}

export const bundleFs: Fs = plainFs()
