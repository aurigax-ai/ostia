import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

const root = process.cwd()
const output = process.argv[2]
const ROOTS = ['src/main', 'src/cli', 'src/node']
const PREREQUISITE_ROOTS = ['src/shared', 'packages/extension-sdk/src/contract']

const CRATE_RULES = [
  [/^src\/cli/, 'cli'],
  [/^src\/node/, 'runner'],
  [/^src\/main\/(platform)(\/|$)/, 'base'],
  [/^src\/main\/control(\/|$)/, 'control'],
  [/^src\/main\/approvals(\/|$)/, 'approvals'],
  [/^src\/main\/(agents|agent|chat|manager)(\/|$)/, 'agents'],
  [/^src\/main\/attention(\/|$)/, 'attention'],
  [/^src\/main\/(panes)(\/|$)/, 'panes'],
  [/^src\/main\/(terminal|tmux)(\/|$)/, 'terminal'],
  [/^src\/main\/(workspaces|windows)(\/|$)/, 'workspaces'],
  [/^src\/main\/(files|links|artifacts)(\/|$)/, 'files'],
  [/^src\/main\/git(\/|$)/, 'git'],
  [/^src\/main\/park(\/|$)/, 'park'],
  [/^src\/main\/ports(\/|$)/, 'ports'],
  [/^src\/main\/(sandbox|sandboxPackages)(\/|$)/, 'sandbox'],
  [/^src\/main\/(secrets|privacy)(\/|$)/, 'privacy'],
  [/^src\/main\/diagnostics(\/|$)/, 'diagnostics'],
  [/^src\/main\/extensions(\/|$)/, 'extensions'],
  [/^src\/main\/lsp(\/|$)/, 'lsp'],
  [/^src\/main\/(gateway|server)(\/|$)/, 'gateway'],
  [/^src\/main\/(profileSync|updates)(\/|$)/, 'sync'],
  [/^src\/main\/browser(\/|$)/, 'browser'],
  [/^src\/main(\/boot)?$/, 'app'],
]

const FOLDER_FLAGS = [
  [/^src\/main\/approvals(\/|$)/, 'capabilities'],
  [/^src\/main\/control$/, 'capabilities'],
  [/^src\/main\/(sandbox|sandboxPackages)(\/|$)/, 'sandbox'],
  [/^src\/main\/(gateway|server)(\/|$)/, 'gateway'],
  [/^src\/main\/secrets(\/|$)/, 'crypto'],
]

const CONTENT_FLAGS = [
  [/from 'node:crypto'|createCipheriv|createHmac|safeStorage/, 'crypto'],
  [/\b(resolveSafe|isInsidePath|readRegularFileSync|realpathSync|O_NOFOLLOW)\b/, 'confinement'],
  [/\b(ensureCaps|connHasCap|needsElevation|hasCap|capAllowedHere)\b/, 'capabilities'],
  [/\b(sandboxedByKernel|isSandboxed|SANDBOXED_REFUSAL)\b/, 'sandbox'],
  [/\b(approvals\(\)|ApprovalOutcome|approver)\b/, 'approvals'],
]

function sourceFiles(dir) {
  const found = []
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) found.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(path)
  }
  return found
}

const isTest = (file) => /\.(test|bench)\.tsx?$/.test(file)

const IMPORT =
  /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^'"\n;]*?(?:\n[^'"\n;]*?)*?\s+from\s+)?['"]([^'"]+)['"]|\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g

const known = new Set()
const BEHAVIOUR =
  /^export\s+(?:default\s+)?(?:(?:async\s+)?function|class|enum)\b|^export\s+const\s+\w+[^=\n]*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=\n]+)?=>/m
const PARTIAL_PORTS = new Set(['src/shared/keyboard/chordSpec.ts'])

function resolveImport(file, spec) {
  let base
  if (spec.startsWith('.')) base = resolve(root, dirname(file), spec)
  else if (spec.startsWith('@aurigax-ai/ostia-extension-sdk/')) {
    base = resolve(root, 'packages/extension-sdk/src', spec.slice(32))
  } else if (spec.startsWith('@shared/')) base = resolve(root, 'src/shared', spec.slice(8))
  else return null
  const rel = relative(root, base)
  for (const candidate of [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`]) {
    if (known.has(candidate)) return candidate
  }
  return null
}

function allImportsTypeOnly(clause) {
  const named = /\{([^}]*)\}/.exec(clause)
  if (!named || /^\s*import\s+[A-Za-z_*]/.test(clause.replace(/^\s*import\s+\{/, 'import {'))) {
    return false
  }
  const names = named[1]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  return names.length > 0 && names.every((name) => name.startsWith('type '))
}

function importsOf(file, text) {
  const out = []
  for (const match of text.matchAll(IMPORT)) {
    const spec = match[3] ?? match[4]
    const target = resolveImport(file, spec)
    if (!target) continue
    out.push({ target, typeOnly: Boolean(match[2]) || allImportsTypeOnly(match[0]) })
  }
  return out
}

const folderOf = (file) => dirname(file)

function crateOf(folder) {
  return CRATE_RULES.find(([pattern]) => pattern.test(folder))?.[1] ?? 'unmapped'
}

const mainFiles = ROOTS.flatMap(sourceFiles)
const prereqFiles = PREREQUISITE_ROOTS.flatMap(sourceFiles)
for (const file of [...mainFiles, ...prereqFiles]) known.add(file)

function emptyFolder(folder) {
  return {
    folder,
    source: 0,
    tests: 0,
    files: 0,
    flags: new Set(),
    electron: false,
    deps: new Set(),
    typeDeps: new Set(),
    prereqs: new Set(),
  }
}

const folders = new Map()
const prereqFolders = new Map()
const fileEntries = new Map()
const sharedEntries = new Map()
const testFiles = []
const sharedTestFiles = []

function record(file, table, isJob) {
  const folder = folderOf(file)
  if (!table.has(folder)) table.set(folder, emptyFolder(folder))
  const entry = table.get(folder)
  const text = readFileSync(join(root, file), 'utf8')
  const lines = text.split('\n').length - 1
  if (isTest(file)) {
    entry.tests += lines
    ;(isJob ? testFiles : sharedTestFiles).push({ file, lines })
    return
  }
  entry.source += lines
  entry.files += 1
  const found = importsOf(file, text).filter(({ target }) => !isTest(target))
  ;(isJob ? fileEntries : sharedEntries).set(file, {
    lines,
    imports: found.filter(({ typeOnly }) => !typeOnly).map(({ target }) => target),
    typeImports: found.filter(({ typeOnly }) => typeOnly).map(({ target }) => target),
    flags: CONTENT_FLAGS.filter(([pattern]) => pattern.test(text)).map(([, flag]) => flag),
    electron: /from 'electron'/.test(text),
    behaviour: BEHAVIOUR.test(text),
    tests: [],
  })
  for (const [pattern, flag] of CONTENT_FLAGS) if (pattern.test(text)) entry.flags.add(flag)
  if (/from 'electron'/.test(text)) entry.electron = true
  for (const { target, typeOnly } of importsOf(file, text)) {
    const other = folderOf(target)
    if (other === folder) continue
    if (PREREQUISITE_ROOTS.some((prefix) => other === prefix || other.startsWith(`${prefix}/`))) {
      entry.prereqs.add(other)
    } else if (isJob) {
      if (typeOnly) entry.typeDeps.add(other)
      else entry.deps.add(other)
    } else {
      entry.prereqs.add(other)
    }
  }
}

for (const file of mainFiles) record(file, folders, true)
for (const file of prereqFiles) record(file, prereqFolders, false)
for (const entry of folders.values()) {
  for (const [pattern, flag] of FOLDER_FLAGS) if (pattern.test(entry.folder)) entry.flags.add(flag)
  for (const dep of entry.typeDeps) if (entry.deps.has(dep)) entry.typeDeps.delete(dep)
}

function stronglyConnected(nodes, edgesOf) {
  const indexOf = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const groups = []
  let next = 0
  const visit = (node) => {
    indexOf.set(node, next)
    low.set(node, next)
    next += 1
    stack.push(node)
    onStack.add(node)
    for (const dep of edgesOf(node)) {
      if (!indexOf.has(dep)) {
        visit(dep)
        low.set(node, Math.min(low.get(node), low.get(dep)))
      } else if (onStack.has(dep)) {
        low.set(node, Math.min(low.get(node), indexOf.get(dep)))
      }
    }
    if (low.get(node) === indexOf.get(node)) {
      const group = []
      let member
      do {
        member = stack.pop()
        onStack.delete(member)
        group.push(member)
      } while (member !== node)
      groups.push(group)
    }
  }
  for (const node of [...nodes].sort()) if (!indexOf.has(node)) visit(node)
  return groups
}

const edges = (node) => [...(folders.get(node)?.deps ?? [])].filter((dep) => folders.has(dep))
const groups = stronglyConnected(folders.keys(), edges)

const sizeOf = (folder) => folders.get(folder).source
const insideEdges = (folder, group) => edges(folder).filter((dep) => group.includes(dep)).length

function row(folder, step, group) {
  const entry = folders.get(folder)
  const list = (values) => [...values].sort().join(' ') || '-'
  const cycle = group.length > 1 ? `C${step}` : '-'
  return `| ${step} | ${cycle} | \`${folder}\` | ${crateOf(folder)} | ${entry.source} | ${entry.tests} | ${entry.files} | ${list(entry.flags)} | ${entry.electron ? 'yes' : '-'} | ${list(entry.deps)} | ${list(entry.typeDeps)} | ${list(entry.prereqs)} |`
}

const rows = []
groups.forEach((group, index) => {
  const ordered = [...group].sort(
    (a, b) => insideEdges(a, group) - insideEdges(b, group) || sizeOf(a) - sizeOf(b),
  )
  for (const folder of ordered) rows.push(row(folder, index + 1, group))
})

const usedBy = new Map()
for (const entry of folders.values()) {
  for (const dep of entry.prereqs) usedBy.set(dep, (usedBy.get(dep) ?? 0) + 1)
}
const prereqRows = stronglyConnected(prereqFolders.keys(), (node) =>
  [...(prereqFolders.get(node)?.prereqs ?? [])].filter((dep) => prereqFolders.has(dep)),
)
  .flat()
  .map((folder) => {
    const entry = prereqFolders.get(folder)
    return `| \`${folder}\` | ${entry.source} | ${entry.tests} | ${usedBy.get(folder) ?? 0} | ${[...entry.flags].sort().join(' ') || '-'} |`
  })

const cycles = groups.filter((group) => group.length > 1)

const JOB_MAX_LINES = 500
const JOB_MAX_FILES = 5

const stemOf = (file) => basename(file).replace(/\..*$/, '')

function attachTests(tests, table) {
  const orphans = []
  for (const test of tests) {
    const stem = stemOf(test.file)
    const candidates = [...table.keys()]
      .filter((file) => folderOf(file) === folderOf(test.file) && stem.startsWith(stemOf(file)))
      .sort((a, b) => stemOf(b).length - stemOf(a).length)
    if (candidates.length > 0) table.get(candidates[0]).tests.push(test)
    else orphans.push(test)
  }
  return orphans
}

const orphanTests = attachTests(testFiles, fileEntries)
const sharedOrphanTests = attachTests(sharedTestFiles, sharedEntries)

function depthsInside(members, table = fileEntries) {
  const depths = new Map()
  const visiting = new Set()
  const loops = new Set()
  const depthOf = (file) => {
    if (depths.has(file)) return depths.get(file)
    if (visiting.has(file)) {
      loops.add(file)
      return 0
    }
    visiting.add(file)
    let depth = 0
    for (const target of table.get(file).imports) {
      if (members.has(target)) depth = Math.max(depth, depthOf(target) + 1)
    }
    visiting.delete(file)
    depths.set(file, depth)
    return depth
  }
  for (const file of members) depthOf(file)
  return { depths, loops }
}

function splitByLimits(files, table = fileEntries) {
  const batches = []
  let batch = []
  let size = 0
  for (const file of files) {
    const lines = table.get(file).lines
    if (batch.length > 0 && (batch.length >= JOB_MAX_FILES || size + lines > JOB_MAX_LINES)) {
      batches.push(batch)
      batch = []
      size = 0
    }
    batch.push(file)
    size += lines
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

function jobsOf(group, cycleId) {
  const folderSet = new Set(group)
  const members = new Set([...fileEntries.keys()].filter((file) => folderSet.has(folderOf(file))))
  const { depths, loops } = depthsInside(members)
  const buckets = new Map()
  for (const file of members) {
    const key = `${String(depths.get(file)).padStart(3, '0')} ${folderOf(file)}`
    buckets.set(key, [...(buckets.get(key) ?? []), file])
  }
  const jobs = []
  const jobOfFile = new Map()
  for (const key of [...buckets.keys()].sort()) {
    for (const files of splitByLimits(buckets.get(key).sort())) {
      const id = `${cycleId}-J${String(jobs.length + 1).padStart(3, '0')}`
      jobs.push({ id, depth: depths.get(files[0]), folder: folderOf(files[0]), files })
      for (const file of files) jobOfFile.set(file, id)
    }
  }
  return { jobs, jobOfFile, members, loops }
}

function jobRow(job, jobOfFile, members) {
  const entries = job.files.map((file) => fileEntries.get(file))
  const needs = new Set()
  const outside = new Set()
  const types = new Set()
  for (const entry of entries) {
    for (const target of entry.imports) {
      if (jobOfFile.has(target)) {
        if (jobOfFile.get(target) !== job.id) needs.add(jobOfFile.get(target))
      } else if (fileEntries.has(target)) outside.add(folderOf(target))
    }
    for (const target of entry.typeImports) {
      if (members.has(target) && folderOf(target) !== job.folder) types.add(folderOf(target))
    }
  }
  const flags = new Set(entries.flatMap((entry) => entry.flags))
  for (const [pattern, flag] of FOLDER_FLAGS) if (pattern.test(job.folder)) flags.add(flag)
  const names = job.files.map((file, at) => `\`${basename(file)}\` ${entries[at].lines}`)
  const tests = entries.flatMap((entry) => entry.tests)
  const testNames = tests.map((test) => `\`${basename(test.file)}\` ${test.lines}`)
  const total = (pick) => entries.reduce((sumOf, entry) => sumOf + pick(entry), 0)
  const list = (values) => [...values].sort().join(' ') || '-'
  return `| ${job.id} | ${job.depth} | \`${job.folder}\` | ${crateOf(job.folder)} | ${names.join(' ')} | ${testNames.join(' ') || '-'} | ${total((entry) => entry.lines)} | ${tests.reduce((sumOf, test) => sumOf + test.lines, 0)} | ${list(flags)} | ${entries.some((entry) => entry.electron) ? 'yes' : '-'} | ${list(needs)} | ${list(outside)} | ${list(types)} |`
}

function cycleSection({ group, cycleId }) {
  const { jobs, jobOfFile, members, loops } = jobsOf(group, cycleId)
  const inCycle = (test) => group.includes(folderOf(test.file))
  const orphans = orphanTests.filter(inCycle)
  return [
    '',
    `## Jobs of cycle ${cycleId}: ${group.length} folders, ${jobs.length} jobs`,
    '',
    `Each job is the files of one folder at one depth, at most ${JOB_MAX_FILES} files and ${JOB_MAX_LINES} source lines, unless one file alone is bigger. Depth counts value imports inside this cycle. Jobs of the same depth can run in parallel. A job can start when every job in Needs is merged, and every folder in Earlier is merged. Types lists folders of this cycle that the job imports with \`import type\`: if the type is not there yet, the job adds it to \`ostia-contract\`.`,
    `Import loops between files in this cycle: ${loops.size}.${loops.size > 0 ? ` Files: ${[...loops].sort().join(' ')}. Order among them is not exact.` : ''}`,
    `Test files with no matching source file: ${orphans.map((test) => `\`${test.file}\``).join(' ') || 'none'}. Give each to the job that owns what it tests.`,
    '',
    '| Job | Depth | Folder | Crate | Files and lines | Tests and lines | Source | Test lines | Security | Electron | Needs | Earlier | Types |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...jobs.map((job) => jobRow(job, jobOfFile, members)),
  ]
}

const snakeOf = (name) => name.replace(/([A-Z])/g, (letter) => `_${letter.toLowerCase()}`)

function rustFiles(kind) {
  const found = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.rs')) found.set(entry.name.slice(0, -3), path)
    }
  }
  for (const crate of readdirSync(join(root, 'crates'), { withFileTypes: true })) {
    if (!crate.isDirectory()) continue
    try {
      walk(`crates/${crate.name}/${kind}`)
    } catch {}
  }
  return found
}

const rustSources = rustFiles('src')
const rustTests = rustFiles('tests')
const UNMATCHABLE = new Set(['index', 'types', 'lib', 'mod', 'constants'])

function portStatus(file, entry) {
  const stem = snakeOf(stemOf(file))
  if (UNMATCHABLE.has(stem)) return 'todo'
  const source = rustSources.get(stem)
  if (!source) return 'todo'
  const crate = source.split('/')[1]
  if (PARTIAL_PORTS.has(file)) return `partial ${crate}`
  if (entry.tests.length > 0 && !rustTests.has(stem)) return `no-tests ${crate}`
  return `ported ${crate}`
}

const stepOfFolder = new Map()
groups.forEach((group, index) => {
  for (const folder of group) stepOfFolder.set(folder, index + 1)
})

function firstNeeded() {
  const needed = new Map()
  const lower = (file, step) => {
    if (step < (needed.get(file) ?? Infinity)) {
      needed.set(file, step)
      return true
    }
    return false
  }
  for (const [file, entry] of fileEntries) {
    for (const target of [...entry.imports, ...entry.typeImports]) {
      if (sharedEntries.has(target)) lower(target, stepOfFolder.get(folderOf(file)))
    }
  }
  let changed = true
  while (changed) {
    changed = false
    for (const [file, entry] of sharedEntries) {
      if (!needed.has(file)) continue
      for (const target of [...entry.imports, ...entry.typeImports]) {
        if (sharedEntries.has(target) && lower(target, needed.get(file))) changed = true
      }
    }
  }
  return needed
}

function sharedSection() {
  const needed = firstNeeded()
  const members = new Set(
    [...sharedEntries].filter(([, e]) => e.behaviour || e.tests.length > 0).map(([f]) => f),
  )
  const { depths } = depthsInside(members, sharedEntries)
  const buckets = new Map()
  for (const file of members) {
    const key = `${String(depths.get(file)).padStart(3, '0')} ${folderOf(file)}`
    buckets.set(key, [...(buckets.get(key) ?? []), file])
  }
  const jobs = []
  for (const key of [...buckets.keys()].sort()) {
    for (const files of splitByLimits(buckets.get(key).sort(), sharedEntries)) {
      jobs.push({
        depth: depths.get(files[0]),
        folder: folderOf(files[0]),
        files,
        step: Math.min(...files.map((file) => needed.get(file) ?? 9999)),
      })
    }
  }
  jobs.sort((a, b) => a.step - b.step || a.depth - b.depth || a.folder.localeCompare(b.folder))
  const jobOfFile = new Map()
  jobs.forEach((job, index) => {
    job.id = `S-J${String(index + 1).padStart(3, '0')}`
    for (const file of job.files) jobOfFile.set(file, job.id)
  })
  const typesOnly = [...sharedEntries].filter(([file]) => !members.has(file))
  const total = (pick) => [...members].reduce((sumOf, file) => sumOf + pick(sharedEntries.get(file)), 0)
  const testLines = total((entry) => entry.tests.reduce((sumOf, test) => sumOf + test.lines, 0))
  const rows = jobs.map((job) => {
    const entries = job.files.map((file) => sharedEntries.get(file))
    const needs = new Set()
    for (const entry of entries) {
      for (const target of entry.imports) {
        const other = jobOfFile.get(target)
        if (other && other !== job.id) needs.add(other)
      }
    }
    const names = job.files.map(
      (file, at) => `\`${basename(file)}\` ${entries[at].lines} ${portStatus(file, entries[at])}`,
    )
    const tests = entries.flatMap((entry) => entry.tests)
    const testNames = tests.map((test) => `\`${basename(test.file)}\` ${test.lines}`)
    const testSum = tests.reduce((sumOf, test) => sumOf + test.lines, 0)
    const sourceSum = entries.reduce((sumOf, entry) => sumOf + entry.lines, 0)
    const step = job.step === 9999 ? 'none' : String(job.step)
    return `| ${job.id} | ${job.depth} | \`${job.folder}\` | ${names.join(' ')} | ${testNames.join(' ') || '-'} | ${sourceSum} | ${testSum} | ${[...needs].sort().join(' ') || '-'} | ${step} |`
  })
  return [
    '',
    `## Shared jobs: ${members.size} modules with behaviour, ${jobs.length} jobs`,
    '',
    `Every file under \`src/shared\` and \`packages/extension-sdk/src/contract\` that exports a function, class, enum or arrow function, or that has a test, with its tests. Files with no behaviour and no test (${typesOnly.length}: types, constants, data tables) have no job. Source lines of jobs: ${total((entry) => entry.lines)}. Test lines: ${testLines}. Each job is the files of one folder at one depth, at most ${JOB_MAX_FILES} files and ${JOB_MAX_LINES} source lines. Jobs are in the order to run: sorted by the first queue step that imports them, then by depth. A job can start when every job in Needs is merged. Port the job before the step in First step.`,
    'Status comes from file names under \`crates/*/src\` and \`crates/*/tests\`: \`ported <crate>\` has source and tests, \`partial <crate>\` has only some functions, \`no-tests <crate>\` has source and no test file, \`todo\` has none. A \`partial\` or \`no-tests\` file still needs its job.',
    `Test files with no matching source file: ${sharedOrphanTests.map((test) => `\`${test.file}\``).join(' ') || 'none'}. Give each to the job that owns what it tests.`,
    '',
    '| Job | Depth | Folder | Files, lines and status | Tests and lines | Source | Test lines | Needs | First step |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
  ]
}

const cycleEntries = groups.flatMap((group, index) =>
  group.length > 1 ? [{ group, cycleId: `C${index + 1}` }] : [],
)

const sum = (pick) => [...folders.values()].reduce((total, entry) => total + pick(entry), 0)
const text = [
  '# Rust port job queue',
  '',
  `Folders: ${folders.size}. Source lines: ${sum((e) => e.source)}. Test lines: ${sum((e) => e.tests)}.`,
  `Value-import cycles between folders: ${cycles.length}. Largest: ${Math.max(0, ...cycles.map((g) => g.length))} folders.`,
  '',
  'Order is leaf first by value imports. A row can start when every earlier step that it names in Depends on is merged.',
  'Rows with a cycle id depend on each other at folder level, so they have no folder job. Use the job table of that cycle, further down. It gives per-file or small-group jobs in file-graph order.',
  'Type deps are `import type` only. They do not set the order. If the type is not there yet, the job adds it to `ostia-contract`.',
  'Security flags come from the folder name and from the source text. A flagged job gets one focused review.',
  'Electron means the folder imports `electron`, so the port needs a seam in place of the Electron API.',
  '',
  '| Step | Cycle | Folder | Crate | Source | Tests | Files | Security | Electron | Depends on | Type deps | Shared needed |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows,
  '',
  '## Shared code that the jobs need',
  '',
  'Port a shared folder into `ostia-contract` before the first job that needs it. If one domain only uses it, put it in that crate. Used by counts job folders.',
  '',
  '| Folder | Source | Tests | Used by | Security |',
  '|---|---|---|---|---|',
  ...prereqRows,
  ...sharedSection(),
  ...cycleEntries.flatMap(cycleSection),
  '',
].join('\n')

if (output) writeFileSync(output, text)
else process.stdout.write(text)
