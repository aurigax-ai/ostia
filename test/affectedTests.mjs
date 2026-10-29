import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { loadQuarantine } from './quarantine.mjs'

export const ROOT = join(import.meta.dirname, '..')

const ROOT_DOC = /^[^/]+\.md$/
const READS_FILES = /from ['"](node:)?fs(\/promises)?['"]/
const UNIT_TEST = /\.test\.tsx?$/
const SPEC = /^e2e\/[^/]+\.spec\.ts$/
const CORE_TAG = /@core\b/
const TEST_CALL = /^\s*test(?:\.(?:only|skip|fixme|fail|slow))?\(/
const QUARANTINE = 'test/quarantine.json'
const QUARANTINE_TEST = 'test/quarantine.test.ts'
const NODE_TEST_DIRS = [
  'src/main',
  'src/shared',
  'src/cli',
  'src/extensions',
  'packages/extension-sdk/src',
]
const SOURCE = /^(src|packages\/[^/]+\/src)\//
const SDK_DIR = 'packages/extension-sdk'
const SDK_IMPORT = /(?:from|import)\s*\(?\s*['"]@aurigax-ai\/ostia-extension-sdk(\/[^'"]+)?['"]/g

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
  'scripts/affectedTests.mjs',
  'scripts/comments.mjs',
  'scripts/mergeQueueVerified.mjs',
  'scripts/quarantine.mjs',
  'scripts/retry.sh',
]

const EVERY_TEST = { node: null, dom: null, e2e: null, e2eChanged: [] }

const E2E_SPECS_PER_SHARD = 20
const E2E_MAX_SHARDS = 4
const E2E_TESTS_PER_SPEC = 5
export const E2E_CHANGED_REPEAT = 3

export function specOf(entry) {
  return entry.replace(/:\d+$/, '')
}

export function e2eWeight(entries) {
  const tests = entries.filter((entry) => entry !== specOf(entry)).length
  return entries.length - tests + Math.ceil(tests / E2E_TESTS_PER_SPEC)
}

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

function isSource(file) {
  return SOURCE.test(file)
}

const GLOBAL_INPUTS = [
  /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|vitest\.config\.mts)$/,
  /^tsconfig[^/]*\.json$/,
  /^test\/(hostEnv|privateTmp|appEnv|quarantineSetup|domEvents|setup|buildOnce|consoleGuard|nodeConsole)\.ts$/,
  /^test\/quarantine\.mjs$/,
  /^test\/mocks\//,
  /^scripts\/build-[^/]+\.mjs$/,
  /^packages\/[^/]+\/(package\.json|scripts\/build\.mjs)$/,
  /^packages\/extension-sdk\/template\/package\.json$/,
  /^electron\.vite\.config\.ts$/,
  /^patches\//,
  /^(biome|knip)\.json$/,
  /^\.jscpd\.json$/,
  /^\.dependency-cruiser[^/]*\.json$/,
]

const PLANNER_TESTS = ['test/affectedTests.test.ts', 'test/e2eAreas.test.ts']

function isGlobalInput(file) {
  return GLOBAL_INPUTS.some((pattern) => pattern.test(file))
}

function isDataFile(file) {
  return !isSource(file) && !ROOT_DOC.test(file) && !readByTests(file) && !isGlobalInput(file)
}

function needlesOf(file) {
  const parts = file.split('/')
  const needles = [file, parts[parts.length - 1]]
  for (let depth = parts.length - 1; depth >= 2; depth--)
    needles.push(parts.slice(0, depth).join('/'))
  return needles
}

function testsNaming(file, texts) {
  const needles = needlesOf(file)
  return Object.keys(texts).filter((test) => needles.some((needle) => texts[test].includes(needle)))
}

function staysInRenderer(file) {
  return !isSource(file) || file.startsWith('src/renderer/')
}

export function planTests(changed, readers, quarantined = []) {
  if (changed.some(isGlobalInput)) return { node: null, dom: null }
  const dataReaders = changed.filter(isDataFile).map((file) => testsNaming(file, readers.texts))
  if (dataReaders.some((tests) => tests.length === 0)) return { node: null, dom: null }
  const dataTests = unique(dataReaders.flat())
  const sources = changed.filter(isSource)
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
          ...dataTests.filter((file) => !inRenderer(file)),
          ...quarantineTests.filter((file) => !inRenderer(file)),
        ])
      : null,
    dom: unique([
      ...sources,
      ...(sources.length > 0 ? readers.dom : []),
      ...dataTests.filter(inRenderer),
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
    if (areas.length === 0 && importers.length === 0) for (const test of map.core) specs.add(test)
  }
  return [...specs].filter((entry) => entry === specOf(entry) || !specs.has(specOf(entry))).sort()
}

export function splitChangedSpecs(planned, changed) {
  const specs = unique(changed.filter((file) => SPEC.test(file))).sort()
  return {
    e2e: planned === null ? null : planned.filter((entry) => !specs.includes(entry)),
    e2eChanged: specs,
  }
}

export function planOutput(tests) {
  return {
    ...tests,
    e2eShards: tests.e2e === null ? null : e2eShards(e2eWeight(tests.e2e)),
    e2eChangedRepeat: E2E_CHANGED_REPEAT,
    e2eChangedShards: e2eShards(e2eWeight(tests.e2eChanged) * E2E_CHANGED_REPEAT),
  }
}

const AREAS_DIR = 'test/e2eAreas'

export function loadE2eMap() {
  const names = readdirSync(join(ROOT, AREAS_DIR))
    .filter((name) => name.endsWith('.json'))
    .sort()
  return {
    areas: names.map((name) => JSON.parse(readFileSync(join(ROOT, AREAS_DIR, name), 'utf8'))),
  }
}

export function e2eSpecs() {
  return readdirSync(join(ROOT, 'e2e'))
    .filter((name) => name.endsWith('.spec.ts'))
    .map((name) => `e2e/${name}`)
    .sort()
}

export function coreTests() {
  return e2eSpecs().flatMap((spec) => {
    const lines = readFileSync(join(ROOT, spec), 'utf8').split('\n')
    const calls = new Set()
    lines.forEach((line, index) => {
      if (!CORE_TAG.test(line)) return
      let call = index
      while (call >= 0 && !TEST_CALL.test(lines[call])) call--
      if (call >= 0) calls.add(`${spec}:${call + 1}`)
    })
    return [...calls]
  })
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

function resolveSdkImport(subpath = '') {
  const { exports } = JSON.parse(readFileSync(join(ROOT, SDK_DIR, 'package.json'), 'utf8'))
  const key = `.${subpath}`
  for (const [pattern, target] of Object.entries(exports)) {
    const [prefix, suffix] = pattern.split('*')
    if (pattern === key) return join(SDK_DIR, target)
    if (suffix === '' && key.startsWith(prefix)) {
      return join(SDK_DIR, target.replace('*', key.slice(prefix.length)))
    }
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
  for (const [, subpath] of text.matchAll(SDK_IMPORT)) {
    const resolved = resolveSdkImport(subpath)
    if (resolved) importsOf(resolved, seen)
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

export function unitTexts() {
  const tests = [
    ...NODE_TEST_DIRS.flatMap(testFiles),
    ...testFiles('src/renderer'),
    ...readdirSync(join(ROOT, 'test'))
      .filter((name) => UNIT_TEST.test(name))
      .map((name) => `test/${name}`),
  ].filter((file) => !PLANNER_TESTS.includes(file))
  return Object.fromEntries(tests.map((file) => [file, readFileSync(join(ROOT, file), 'utf8')]))
}

function fileReaders() {
  return { dom: domFileReaders(), folders: nodeFolderReaders(), texts: unitTexts() }
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
  const map = { ...loadE2eMap(), core: coreTests() }
  const e2e = planE2e(changed, map, e2eImports(), quarantined)
  const present = (entry) => existsSync(join(ROOT, specOf(entry)))
  return {
    ...planTests(changed, fileReaders(), quarantined),
    ...splitChangedSpecs(e2e === null ? null : e2e.filter(present), changed.filter(present)),
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
