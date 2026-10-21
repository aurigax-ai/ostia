import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import semver from 'semver'

const manifestFile = 'ostia-marketplace.json'
const extensionFile = 'ostia.json'

export function placement(current, incoming) {
  if (!current) return 'newest'
  const stable = (version) => semver.prerelease(version) === null
  if (stable(current) !== stable(incoming)) return stable(incoming) ? 'newest' : 'history'
  return semver.gt(incoming, current) ? 'newest' : 'history'
}

export function historyFolders(root) {
  const base = join(root, 'versions')
  if (!existsSync(base)) return []
  return readdirSync(base)
    .sort()
    .flatMap((id) =>
      readdirSync(join(base, id))
        .sort(semver.compare)
        .map((version) => `versions/${id}/${version}`),
    )
}

function versionIn(dir) {
  return JSON.parse(readFileSync(join(dir, extensionFile), 'utf8')).version
}

function listedIds(root) {
  const manifest = JSON.parse(readFileSync(join(root, manifestFile), 'utf8'))
  const folders = [...manifest.extensions, ...(manifest.unlisted ?? []).map((entry) => entry.path)]
  return folders.map((folder) => folder.replace(/^extensions\//, ''))
}

function unpack(archive) {
  const dir = mkdtempSync(join(tmpdir(), 'release-'))
  execFileSync('tar', ['-xzf', archive, '-C', dir])
  const [id, ...more] = readdirSync(dir)
  if (!id || more.length > 0) throw new Error(`${archive} must hold one extension folder`)
  return { id, dir: join(dir, id) }
}

export function syncRelease(root, archive, sourceDir) {
  const { id, dir } = unpack(archive)
  const version = versionIn(dir)
  if (!listedIds(root).includes(id)) {
    throw new Error(`${id} is not in ${manifestFile}: add it in a pull request first`)
  }
  const newest = join(root, 'extensions', id)
  const current = existsSync(newest) ? versionIn(newest) : null
  if (current === version || existsSync(join(root, 'versions', id, version))) return null
  if (placement(current, version) === 'history') {
    mkdirSync(join(root, 'versions', id), { recursive: true })
    cpSync(dir, join(root, 'versions', id, version), { recursive: true })
    return { id, version, newest: false }
  }
  if (current) {
    mkdirSync(join(root, 'versions', id), { recursive: true })
    renameSync(newest, join(root, 'versions', id, current))
  }
  cpSync(dir, newest, { recursive: true })
  rmSync(join(root, 'src/extensions', id), { recursive: true, force: true })
  cpSync(sourceDir, join(root, 'src/extensions', id), { recursive: true })
  return { id, version, newest: true }
}

export function writeHistory(root) {
  const file = join(root, manifestFile)
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  const history = historyFolders(root)
  if (history.length > 0) manifest.history = history
  else delete manifest.history
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
}

if (process.argv[1] === import.meta.filename) {
  const [root, assets, sources] = process.argv.slice(2)
  if (!root || !assets || !sources) {
    console.error('usage: node sync-releases.mjs <marketplace> <assets folder> <sources folder>')
    process.exit(1)
  }
  const ordered = readdirSync(assets)
    .filter((name) => name.endsWith('.tar.gz'))
    .sort()
  for (const name of ordered) {
    const base = name.replace(/\.tar\.gz$/, '')
    const placed = syncRelease(root, join(assets, name), join(sources, base))
    if (placed)
      console.log(`${placed.id} ${placed.version} -> ${placed.newest ? 'extensions' : 'versions'}`)
  }
  writeHistory(root)
}
