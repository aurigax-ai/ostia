import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const versionSource = 'src/shared/extensionApi.ts'
const versionPattern = /EXTENSION_API_VERSION = '(\d+)\.(\d+)'/
export const lockFile = 'sdk-package/api-lock.json'

export function apiVersion() {
  const match = versionPattern.exec(readFileSync(versionSource, 'utf8'))
  if (!match) throw new Error(`EXTENSION_API_VERSION not found in ${versionSource}`)
  return `${match[1]}.${match[2]}`
}

export function writeApiVersion(version) {
  const source = readFileSync(versionSource, 'utf8')
  writeFileSync(
    versionSource,
    source.replace(versionPattern, `EXTENSION_API_VERSION = '${version}'`),
  )
}

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
    )
    .sort()
}

export function contractDigest(sdkDir) {
  const hash = createHash('sha256')
  for (const part of ['schemas', 'types']) {
    for (const file of filesUnder(join(sdkDir, part))) {
      hash.update(relative(sdkDir, file))
      hash.update('\0')
      hash.update(readFileSync(file))
      hash.update('\0')
    }
  }
  return hash.digest('hex')
}

export function inTreeManifests() {
  const extensions = readdirSync('src/extensions', { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'sdk')
    .map((entry) => join('src/extensions', entry.name, 'ostia.json'))
  return [...extensions, 'sdk-package/template/ostia.json']
}

export function writeManifestApi(file, version) {
  const text = readFileSync(file, 'utf8')
  writeFileSync(file, text.replace(/"api": "\d+\.\d+"/, `"api": "${version}"`))
}

export function readLock() {
  return JSON.parse(readFileSync(lockFile, 'utf8'))
}

export function writeLock(lock) {
  writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`)
}
