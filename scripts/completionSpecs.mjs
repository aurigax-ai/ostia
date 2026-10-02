import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/
const MAX_LOAD_DEPTH = 4
const MAX_SPEC_BYTES = 4 * 1024 * 1024

const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])
const text = (v) => (typeof v === 'string' && v ? v : undefined)

function nameList(raw) {
  return asArray(raw).filter((n) => typeof n === 'string' && n.length > 0)
}

function suggestion(raw) {
  if (typeof raw === 'string') return raw ? { name: raw } : null
  if (!raw || typeof raw !== 'object' || raw.hidden) return null
  const [name] = nameList(raw.name)
  if (!name) return null
  const description = text(raw.description)
  return description ? { name, description } : { name }
}

function templates(raw) {
  const all = [
    ...asArray(raw.template),
    ...asArray(raw.generators).flatMap((g) => asArray(g?.template)),
  ]
  return [...new Set(all.filter((t) => t === 'filepaths' || t === 'folders'))]
}

function arg(raw) {
  if (!raw || typeof raw !== 'object') return null
  const out = {}
  if (text(raw.name)) out.name = raw.name
  if (text(raw.description)) out.description = raw.description
  const suggestions = asArray(raw.suggestions).map(suggestion).filter(Boolean)
  if (suggestions.length) out.suggestions = suggestions
  const template = templates(raw)
  if (template.length) out.template = template
  if (raw.isOptional) out.isOptional = true
  if (raw.isVariadic) out.isVariadic = true
  return out
}

function option(raw) {
  if (!raw || typeof raw !== 'object' || raw.hidden) return null
  const names = nameList(raw.name)
  if (!names.length) return null
  const out = { names }
  if (text(raw.description)) out.description = raw.description
  const args = asArray(raw.args).map(arg).filter(Boolean)
  if (args.length) out.args = args
  if (raw.isPersistent) out.isPersistent = true
  if (raw.isRepeatable) out.isRepeatable = true
  return out
}

async function loadModule(buildDir, rel) {
  const file = join(buildDir, `${rel}.js`)
  if (!existsSync(file)) return null
  try {
    const mod = await import(pathToFileURL(file).href)
    const spec = mod.default
    return spec && typeof spec === 'object' ? spec : null
  } catch {
    return null
  }
}

async function command(raw, buildDir, loadDepth, maxLoadDepth) {
  if (!raw || typeof raw !== 'object' || raw.hidden) return null
  const names = nameList(raw.name)
  if (!names.length) return null
  let source = raw
  if (typeof raw.loadSpec === 'string' && loadDepth < maxLoadDepth) {
    const loaded = await loadModule(buildDir, raw.loadSpec)
    if (loaded)
      source = {
        ...loaded,
        ...raw,
        subcommands: loaded.subcommands,
        options: loaded.options,
        args: loaded.args,
      }
  }
  const out = { names }
  if (text(source.description)) out.description = source.description
  const subcommands = []
  for (const sub of asArray(source.subcommands)) {
    const parsed = await command(sub, buildDir, loadDepth + (source === raw ? 0 : 1), maxLoadDepth)
    if (parsed) subcommands.push(parsed)
  }
  if (subcommands.length) out.subcommands = subcommands
  const options = asArray(source.options).map(option).filter(Boolean)
  if (options.length) out.options = options
  const args = asArray(source.args).map(arg).filter(Boolean)
  if (args.length) out.args = args
  return out
}

export async function writeFigSpecs(outDir) {
  const buildDir = join(dirname(import.meta.dirname), 'node_modules/@withfig/autocomplete/build')
  mkdirSync(outDir, { recursive: true })
  copyFileSync(join(dirname(buildDir), 'LICENSE'), join(outDir, 'LICENSE-withfig-autocomplete'))
  let count = 0
  for (const file of readdirSync(buildDir)) {
    if (!file.endsWith('.js')) continue
    const name = file.slice(0, -3)
    if (!COMMAND.test(name)) continue
    const spec = await loadModule(buildDir, name)
    if (!spec) continue
    let json = JSON.stringify(await command({ ...spec, name }, buildDir, 0, MAX_LOAD_DEPTH))
    if (json.length > MAX_SPEC_BYTES)
      json = JSON.stringify(await command({ ...spec, name }, buildDir, 0, 0))
    if (!json || json === 'null' || json.length > MAX_SPEC_BYTES) continue
    writeFileSync(join(outDir, `${name}.json`), json)
    count++
  }
  return count
}
