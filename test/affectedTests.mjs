import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { loadQuarantine } from './quarantine.mjs'

export const ROOT = join(import.meta.dirname, '..')

const ROOT_DOC = /^[^/]+\.md$/
const READS_FILES = /from ['"](node:)?fs(\/promises)?['"]/
const UNIT_TEST = /\.test\.tsx?$/
const SPEC = /^e2e\/[^/]+\.spec\.ts$/
const QUARANTINE = 'test/quarantine.json'
const QUARANTINE_TEST = 'test/quarantine.test.ts'
const NODE_TEST_DIRS = ['src/main', 'src/shared', 'src/cli', 'src/extensions']

const READ_FOLDERS = [
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

const EVERY_TEST = { node: null, dom: null, e2e: null }

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

function loadE2eMap() {
  return JSON.parse(readFileSync(join(ROOT, 'test/e2eAreas.json'), 'utf8'))
}

export function e2eSpecs() {
  return readdirSync(join(ROOT, 'e2e'))
    .filter((name) => name.endsWith('.spec.ts'))
    .map((name) => `e2e/${name}`)
    .sort()
}

const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g
const IMPORT_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.mjs', '.js', '/index.ts']

function resolveImport(from, target) {
  for (const suffix of IMPORT_SUFFIXES) {
    const path = join(ROOT, dirname(from), target + suffix)
    if (existsSync(path) && statSync(path).isFile()) return relative(ROOT, path)
  }
  return null
}

function importsOf(file, seen) {
  if (seen.has(file)) return
  seen.add(file)
  const text = readFileSync(join(ROOT, file), 'utf8')
  for (const [, target] of text.matchAll(RELATIVE_IMPORT)) {
    const resolved = resolveImport(file, target)
    if (resolved && !resolved.startsWith('..')) importsOf(resolved, seen)
  }
}

export function e2eImports() {
  return Object.fromEntries(
    e2eSpecs().map((spec) => {
      const seen = new Set()
      importsOf(spec, seen)
      seen.delete(spec)
      return [spec, [...seen].sort()]
    }),
  )
}

function testFiles(dir) {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => UNIT_TEST.test(file))
    .map((file) => `${dir}/${file}`)
}

function readsFiles(file) {
  return READS_FILES.test(readFileSync(join(ROOT, file), 'utf8'))
}

export function domFileReaders() {
  return testFiles('src/renderer').filter(readsFiles).sort()
}

export function nodeFolderReaders() {
  const readers = [
    ...NODE_TEST_DIRS.flatMap(testFiles),
    ...readdirSync(join(ROOT, 'test'))
      .filter((name) => UNIT_TEST.test(name))
      .map((name) => `test/${name}`),
  ].filter(readsFiles)
  return Object.fromEntries(
    READ_FOLDERS.map(({ folder, named }) => [
      folder,
      readers.filter((file) => named.test(readFileSync(join(ROOT, file), 'utf8'))).sort(),
    ]),
  )
}

function fileReaders() {
  return { dom: domFileReaders(), folders: nodeFolderReaders() }
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

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }).trim()
}

function quarantineAt(base) {
  try {
    return JSON.parse(git('show', `${base}:${QUARANTINE}`))
  } catch {
    return []
  }
}

export function planChanges(changed, base) {
  const quarantined = changed.includes(QUARANTINE)
    ? changedQuarantineFiles(quarantineAt(base), loadQuarantine())
    : []
  const e2e = planE2e(changed, loadE2eMap(), e2eImports(), quarantined)
  return {
    ...planTests(changed, fileReaders(), quarantined),
    e2e: e2e === null ? null : e2e.filter((spec) => existsSync(join(ROOT, spec))),
  }
}

export function planAgainst(baseRef) {
  try {
    const base = git('merge-base', baseRef, 'HEAD')
    const changed = git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean)
    return { tests: planChanges(changed, base), problem: null }
  } catch (error) {
    return { tests: EVERY_TEST, problem: String(error.stderr || error.message).trim() }
  }
}
