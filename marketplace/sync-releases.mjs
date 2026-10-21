import { execFileSync } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
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
const signatureFile = 'ostia.sig'
const keyFile = 'official-key.json'
const TAG_PATTERN = /^ext\/([a-z][a-z0-9-]{1,39})\/v(.+)$/

export function parseExtensionTag(tag) {
  const match = TAG_PATTERN.exec(tag)
  if (!match || semver.clean(match[2]) !== match[2]) return null
  return { id: match[1], version: match[2] }
}

export function placement(current, incoming) {
  if (semver.prerelease(incoming) !== null) return 'history'
  if (!current) return 'newest'
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

function readManifest(dir) {
  return JSON.parse(readFileSync(join(dir, extensionFile), 'utf8'))
}

function heldVersion(root, id) {
  const newest = join(root, 'extensions', id)
  return existsSync(newest) ? readManifest(newest).version : null
}

export function unseen(root, tags) {
  const found = []
  for (const tag of tags) {
    const parsed = parseExtensionTag(tag)
    if (!parsed) continue
    const { id, version } = parsed
    if (heldVersion(root, id) === version || existsSync(join(root, 'versions', id, version))) {
      continue
    }
    found.push({ tag, id, version })
  }
  return found
}

function listedIds(root) {
  const manifest = JSON.parse(readFileSync(join(root, manifestFile), 'utf8'))
  const folders = [...manifest.extensions, ...(manifest.unlisted ?? []).map((entry) => entry.path)]
  return folders.map((folder) => folder.replace(/^extensions\//, ''))
}

function regularFiles(dir, rel = '') {
  const files = []
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (rel === '' && entry.name === '.git') throw new Error('a release holds a .git entry')
    if (entry.isDirectory()) files.push(...regularFiles(dir, path))
    else if (entry.isFile() && lstatSync(join(dir, path)).nlink === 1) files.push(path)
    else throw new Error(`${path} is not a plain file`)
  }
  return files
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

export function signatureProblem(dir, id, version, publicKey) {
  if (!publicKey) return `${keyFile} holds no official key`
  let key
  try {
    key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
  } catch {
    return `${keyFile} holds no usable key`
  }
  if (key.asymmetricKeyType !== 'ed25519') return `${keyFile} does not hold an Ed25519 key`
  let signed
  try {
    signed = JSON.parse(readFileSync(join(dir, signatureFile), 'utf8'))
  } catch {
    return `${signatureFile} is missing or unreadable`
  }
  const lines = regularFiles(dir)
    .filter((file) => file !== signatureFile)
    .map((file) => `${file}\0${sha256(readFileSync(join(dir, file)))}\n`)
    .sort()
  const digest = sha256(lines.join(''))
  if (digest !== signed.digest) return 'the files differ from what was signed'
  const genuine = verify(
    null,
    Buffer.from(`ostia-extension/v1\n${id}\n${version}\n${digest}`),
    key,
    Buffer.from(String(signed.signature), 'base64'),
  )
  return genuine ? null : 'the signature does not match'
}

function unpack(archive) {
  const dir = mkdtempSync(join(tmpdir(), 'release-'))
  execFileSync('tar', ['-xzf', archive, '-C', dir, '--no-same-owner', '--no-same-permissions'])
  const names = readdirSync(dir)
  if (names.length !== 1) throw new Error(`${archive} must hold one extension folder`)
  return { name: names[0], dir: join(dir, names[0]) }
}

export function syncRelease(root, archive, sourceDir, expected, publicKey) {
  const { id, version } = expected
  const { name, dir } = unpack(archive)
  if (name !== id) throw new Error(`${archive} holds ${name}, not ${id}`)
  const built = readManifest(dir)
  if (built.id !== id || built.version !== version) {
    throw new Error(`${archive} says ${built.id} ${built.version}, not ${id} ${version}`)
  }
  const problem = signatureProblem(dir, id, version, publicKey)
  if (problem) throw new Error(`${id} ${version}: ${problem}`)
  const source = readManifest(sourceDir)
  if (source.id !== id || source.version !== version) {
    throw new Error(`the source of ${id} ${version} says ${source.id} ${source.version}`)
  }
  if (!listedIds(root).includes(id)) {
    throw new Error(`${id} is not in ${manifestFile}: add it in a pull request first`)
  }
  const current = heldVersion(root, id)
  if (current === version || existsSync(join(root, 'versions', id, version))) return null
  const where = placement(current, version)
  if (where === 'history') {
    if (!current) throw new Error(`${id} has no stable release yet: release a stable one first`)
    mkdirSync(join(root, 'versions', id), { recursive: true })
    cpSync(dir, join(root, 'versions', id, version), { recursive: true })
    return { id, version, newest: false }
  }
  const newest = join(root, 'extensions', id)
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

function officialKey(root) {
  return JSON.parse(readFileSync(join(root, keyFile), 'utf8')).publicKey
}

if (process.argv[1] === import.meta.filename) {
  const [verb, root, assets, sources] = process.argv.slice(2)
  if (verb === 'unseen' && root) {
    const tags = readFileSync(0, 'utf8').split('\n').filter(Boolean)
    for (const { tag, id, version } of unseen(root, tags)) console.log(`${tag}\t${id}\t${version}`)
  } else if (verb === 'place' && root && assets && sources) {
    const key = officialKey(root)
    const ordered = readdirSync(assets)
      .filter((name) => name.endsWith('.tar.gz'))
      .map((name) => name.replace(/\.tar\.gz$/, ''))
      .sort()
    for (const base of ordered) {
      const at = base.search(/-\d+\.\d+\.\d+/)
      const parsed = at > 0 && parseExtensionTag(`ext/${base.slice(0, at)}/v${base.slice(at + 1)}`)
      if (!parsed) throw new Error(`${base} is not <id>-<version>`)
      const placed = syncRelease(
        root,
        join(assets, `${base}.tar.gz`),
        join(sources, base),
        parsed,
        key,
      )
      if (placed)
        console.log(
          `${placed.id} ${placed.version} -> ${placed.newest ? 'extensions' : 'versions'}`,
        )
    }
    writeHistory(root)
  } else {
    console.error('usage: node sync-releases.mjs unseen <marketplace>   (release tags on stdin)')
    console.error(
      '       node sync-releases.mjs place <marketplace> <assets folder> <sources folder>',
    )
    process.exit(1)
  }
}
