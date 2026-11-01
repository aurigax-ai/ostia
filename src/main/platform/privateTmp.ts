import { hash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { appDataDir, type EnvSource } from './userDirs'

export function socketPathLimit(platform: NodeJS.Platform): number {
  return platform === 'darwin' ? 103 : 107
}

const SHORT_SOCKET_BASE = '/tmp'

function ownedPrivateDir(dir: string, uid: number): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid) {
    throw new Error(`refusing to use ${dir}: not a directory owned by uid ${uid}`)
  }
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700)
  return dir
}

export function privateTmpDir(name: string): string {
  if (process.platform === 'win32') {
    const dir = join(tmpdir(), name)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const uid = process.getuid?.() ?? 0
  return ownedPrivateDir(join(tmpdir(), `${name}-${uid}`), uid)
}

export function privateRunDir(
  name: string,
  platform: NodeJS.Platform = process.platform,
  env: EnvSource = process.env,
  home: string = homedir(),
): string {
  if (platform === 'darwin') {
    return ownedPrivateDir(join(appDataDir(env, home), 'run', name), process.getuid?.() ?? 0)
  }
  return privateTmpDir(`${PRODUCT_NAME}-${name}`)
}

export function socketPath(
  dir: string,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const preferred = join(dir, name)
  if (platform === 'win32' || Buffer.byteLength(preferred) <= socketPathLimit(platform)) {
    return preferred
  }
  const uid = process.getuid?.() ?? 0
  const short = ownedPrivateDir(join(SHORT_SOCKET_BASE, `${PRODUCT_NAME}-${uid}`), uid)
  const digest = hash('sha256', preferred).slice(0, 16)
  return join(short, `${digest}.sock`)
}
