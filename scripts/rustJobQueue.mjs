import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

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

function record(file, table, isJob) {
  const folder = folderOf(file)
  if (!table.has(folder)) table.set(folder, emptyFolder(folder))
  const entry = table.get(folder)
  const text = readFileSync(join(root, file), 'utf8')
  const lines = text.split('\n').length - 1
  if (isTest(file)) {
    entry.tests += lines
    return
  }
  entry.source += lines
  entry.files += 1
  if (isJob) {
    const imports = importsOf(file, text).filter(
      ({ typeOnly, target }) => !typeOnly && !isTest(target),
    )
    fileEntries.set(file, { lines, imports: imports.map(({ target }) => target) })
  }
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

function fileDepths() {
  const depths = new Map()
  const visiting = new Set()
  const depthOf = (file) => {
    if (depths.has(file)) return depths.get(file)
    if (visiting.has(file)) return 0
    visiting.add(file)
    let depth = 0
    for (const target of fileEntries.get(file)?.imports ?? []) {
      if (fileEntries.has(target)) depth = Math.max(depth, depthOf(target) + 1)
    }
    visiting.delete(file)
    depths.set(file, depth)
    return depth
  }
  for (const file of fileEntries.keys()) depthOf(file)
  return depths
}

const depths = fileDepths()

function cycleSection(group) {
  const members = new Set(group)
  const files = [...fileEntries.keys()]
    .filter((file) => members.has(folderOf(file)))
    .sort((a, b) => depths.get(a) - depths.get(b) || a.localeCompare(b))
  const crossing = (file) =>
    fileEntries.get(file).imports.filter((target) => {
      const other = folderOf(target)
      return other !== folderOf(file) && members.has(other)
    })
  return [
    '',
    `## Files of the cycle that has ${group.length} folders`,
    '',
    'The file graph has no runtime cycle (`no-cycles` in `.dependency-cruiser.json`), so this cycle exists only at folder level. Files of the same depth can run in parallel once all lower depths are merged. Imports lists the imports that cross a folder inside the cycle.',
    '',
    '| Depth | File | Lines | Imports |',
    '|---|---|---|---|',
    ...files.map(
      (file) =>
        `| ${depths.get(file)} | \`${file}\` | ${fileEntries.get(file).lines} | ${crossing(file).join(' ') || '-'} |`,
    ),
  ]
}
const sum = (pick) => [...folders.values()].reduce((total, entry) => total + pick(entry), 0)
const text = [
  '# Rust port job queue',
  '',
  `Folders: ${folders.size}. Source lines: ${sum((e) => e.source)}. Test lines: ${sum((e) => e.tests)}.`,
  `Value-import cycles between folders: ${cycles.length}. Largest: ${Math.max(0, ...cycles.map((g) => g.length))} folders.`,
  '',
  'Order is leaf first by value imports. A row can start when every earlier step that it names in Depends on is merged.',
  'Rows with the same cycle id depend on each other. Port them together, or break the cycle with a seam in the crate that comes first.',
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
  ...cycles.flatMap(cycleSection),
  '',
].join('\n')

if (output) writeFileSync(output, text)
else process.stdout.write(text)
