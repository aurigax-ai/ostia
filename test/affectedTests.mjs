import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

export const ROOT = join(import.meta.dirname, '..')

const ROOT_DOC = /^[^/]+\.md$/
const READS_FILES = /from ['"](node:)?fs(\/promises)?['"]/
const UNIT_TEST = /\.test\.tsx?$/
const SPEC = /^e2e\/[^/]+\.spec\.ts$/
const QUARANTINE = 'test/quarantine.json'
const QUARANTINE_TEST = 'test/quarantine.test.ts'
const NODE_TEST_DIRS = ['src/main', 'src/shared', 'src/cli', 'src/extensions']

export const READ_FOLDERS = [
  { folder: 'e2e/', named: /['"`]e2e['"`/]/ },
  { folder: '.github/', named: /['"`]\.github\// },
]

export const E2E_HARNESS = [
  'e2e/helpers.ts',
  'e2e/dataHome.ts',
  'e2e/test.ts',
  'playwright.config.ts',
  'scripts/e2e.sh',
]

const UNIT_ONLY_FILES = [
  'biome.json',
  'vitest.config.mts',
  'vitest.workspace.mts',
  'scripts/affectedTests.mjs',
  'scripts/comments.mjs',
  'scripts/mergeQueueVerified.mjs',
  'scripts/quarantine.mjs',
  'scripts/retry.sh',
]

export const EVERY_TEST = { node: null, dom: null, e2e: null }

export const E2E_SPECS_PER_SHARD = 20
export const E2E_MAX_SHARDS = 4

export function e2eShards(specCount) {
  const shards = Math.min(E2E_MAX_SHARDS, Math.max(1, Math.ceil(specCount / E2E_SPECS_PER_SHARD)))
  return Array.from({ length: shards }, (_, index) => index + 1)
}

function unique(files) {
  return [...new Set(files)]
}

function readByTests(file) {
  return file === QUARANTINE || READ_FOLDERS.some(({ folder }) => file.startsWith(folder))
}

function runsEverything(file) {
  return !file.startsWith('src/') && !ROOT_DOC.test(file) && !readByTests(file)
}

function staysInRenderer(file) {
  return (
    !file.startsWith('src/') ||
    (file.startsWith('src/renderer/') && !file.startsWith('src/renderer/i18n/'))
  )
}

export function planTests(changed, readers, quarantined = []) {
  if (changed.some(runsEverything)) return { node: null, dom: null }
  const sources = changed.filter((file) => file.startsWith('src/'))
  const folderReaders = READ_FOLDERS.filter(({ folder }) =>
    changed.some((file) => file.startsWith(folder)),
  ).flatMap(({ folder }) => readers.folders[folder] ?? [])
  const quarantineTests = changed.includes(QUARANTINE)
    ? [QUARANTINE_TEST, ...quarantined.filter((file) => UNIT_TEST.test(file))]
    : []
  const inRenderer = (file) => file.startsWith('src/renderer/')
  return {
    node: sources.every(staysInRenderer)
      ? unique([
          ...sources,
          ...folderReaders,
          ...quarantineTests.filter((file) => !inRenderer(file)),
        ])
      : null,
    dom: unique([
      ...sources,
      ...(sources.length > 0 ? readers.dom : []),
      ...quarantineTests.filter(inRenderer),
    ]),
  }
}

function skipsE2e(file) {
  return (
    ROOT_DOC.test(file) ||
    file === QUARANTINE ||
    file.startsWith('.github/') ||
    UNIT_TEST.test(file) ||
    UNIT_ONLY_FILES.includes(file) ||
    (file.startsWith('test/') && !file.startsWith('test/fixtures/'))
  )
}

export function areasOf(file, map) {
  return map.areas.filter((area) => area.paths.some((path) => file.startsWith(path)))
}

export function planE2e(changed, map, imports, quarantined = []) {
  if (changed.some((file) => E2E_HARNESS.includes(file))) return null
  const specs = new Set(quarantined.filter((file) => SPEC.test(file)))
  for (const file of changed) {
    if (SPEC.test(file)) {
      specs.add(file)
      continue
    }
    const importers = Object.keys(imports).filter((spec) => imports[spec].includes(file))
    for (const spec of importers) specs.add(spec)
    if (file.startsWith('e2e/') || skipsE2e(file)) continue
    const areas = areasOf(file, map)
    for (const area of areas) for (const spec of area.specs) specs.add(spec)
    if (areas.length === 0 && importers.length === 0) for (const spec of map.smoke) specs.add(spec)
  }
  return [...specs].sort()
}

export function loadE2eMap(root = ROOT) {
  return JSON.parse(readFileSync(join(root, 'test/e2eAreas.json'), 'utf8'))
}

export function e2eSpecs(root = ROOT) {
  return readdirSync(join(root, 'e2e'))
    .filter((name) => name.endsWith('.spec.ts'))
    .map((name) => `e2e/${name}`)
    .sort()
}

const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g
const IMPORT_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.mjs', '.js', '/index.ts']

function resolveImport(root, from, target) {
  for (const suffix of IMPORT_SUFFIXES) {
    const path = join(root, dirname(from), target + suffix)
    if (existsSync(path) && statSync(path).isFile()) return relative(root, path)
  }
  return null
}

function importsOf(root, file, seen) {
  if (seen.has(file)) return
  seen.add(file)
  const text = readFileSync(join(root, file), 'utf8')
  for (const [, target] of text.matchAll(RELATIVE_IMPORT)) {
    const resolved = resolveImport(root, file, target)
    if (resolved && !resolved.startsWith('..')) importsOf(root, resolved, seen)
  }
}

export function e2eImports(root = ROOT) {
  return Object.fromEntries(
    e2eSpecs(root).map((spec) => {
      const seen = new Set()
      importsOf(root, spec, seen)
      seen.delete(spec)
      return [spec, [...seen].sort()]
    }),
  )
}

function testFiles(root, dir) {
  return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => UNIT_TEST.test(file))
    .map((file) => `${dir}/${file}`)
}

function readsFiles(root, file) {
  return READS_FILES.test(readFileSync(join(root, file), 'utf8'))
}

export function domFileReaders(root = ROOT) {
  return testFiles(root, 'src/renderer')
    .filter((file) => readsFiles(root, file))
    .sort()
}

export function nodeFolderReaders(root = ROOT) {
  const readers = [
    ...NODE_TEST_DIRS.flatMap((dir) => testFiles(root, dir)),
    ...readdirSync(join(root, 'test'))
      .filter((name) => UNIT_TEST.test(name))
      .map((name) => `test/${name}`),
  ].filter((file) => readsFiles(root, file))
  return Object.fromEntries(
    READ_FOLDERS.map(({ folder, named }) => [
      folder,
      readers.filter((file) => named.test(readFileSync(join(root, file), 'utf8'))).sort(),
    ]),
  )
}

export function fileReaders(root = ROOT) {
  return { dom: domFileReaders(root), folders: nodeFolderReaders(root) }
}

export function changedQuarantineFiles(before, after) {
  const keyed = (entries) => new Map(entries.map((entry) => [JSON.stringify(entry), entry.file]))
  const was = keyed(before)
  const now = keyed(after)
  const changed = [
    ...[...was].filter(([key]) => !now.has(key)),
    ...[...now].filter(([key]) => !was.has(key)),
  ]
  return unique(changed.map(([, file]) => file)).sort()
}

export function vitestArgs(project, files) {
  if (files === null) return ['run', '--project', project]
  return ['related', '--run', '--project', project, '--passWithNoTests', ...files]
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim()
}

function quarantineAt(root, base) {
  try {
    return JSON.parse(git(root, 'show', `${base}:${QUARANTINE}`))
  } catch {
    return []
  }
}

export function planChanges(changed, root = ROOT, base = null) {
  const quarantined = changed.includes(QUARANTINE)
    ? changedQuarantineFiles(
        base ? quarantineAt(root, base) : [],
        existsSync(join(root, QUARANTINE))
          ? JSON.parse(readFileSync(join(root, QUARANTINE), 'utf8'))
          : [],
      )
    : []
  const e2e = planE2e(changed, loadE2eMap(root), e2eImports(root), quarantined)
  return {
    ...planTests(changed, fileReaders(root), quarantined),
    e2e: e2e === null ? null : e2e.filter((spec) => existsSync(join(root, spec))),
  }
}

export function planAgainst(baseRef, root = ROOT) {
  try {
    const base = git(root, 'merge-base', baseRef, 'HEAD')
    const changed = git(root, 'diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean)
    return { tests: planChanges(changed, root, base), problem: null }
  } catch (error) {
    return { tests: EVERY_TEST, problem: String(error.stderr || error.message).trim() }
  }
}
