import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { compareCatalog } from './i18nCompare.mjs'
import { BASE_LANGUAGE, EXTENSIONS_DIR, flatten } from './i18nCatalog.mjs'
import { extensionIds } from './i18nPacks.mjs'

const TRANSLATOR_NAMES = new Set(['t', 'tr'])
const SOURCE = /\.ts$/
const NOT_SOURCE = /\.(test|d)\.ts$/

function readJson(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
}

function sourceFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE.test(entry.name) && !NOT_SOURCE.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function templatePattern(node) {
  const parts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]
  if (!parts.join('') || parts.some((part) => /\s/.test(part))) return null
  return new RegExp(`^${parts.map(escape).join('.+')}$`)
}

function shownToHumans(raw) {
  const agentOnly = new Set((raw.contributes?.commands ?? []).filter((c) => c.palette === false).map((c) => c.id))
  return (key) => {
    const match = /^commands\.(.+)\.(title|category|argument)$/.exec(key)
    return !match || !agentOnly.has(match[1])
  }
}

function scanUsage(file) {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const literals = new Set()
  const patterns = []
  const calls = []
  const visit = (node) => {
    if (ts.isStringLiteralLike(node)) literals.add(node.text)
    const pattern = ts.isTemplateExpression(node) ? templatePattern(node) : null
    if (pattern) patterns.push(pattern)
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      TRANSLATOR_NAMES.has(node.expression.text) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.arguments[0].getStart())
      calls.push({ key: node.arguments[0].text, line: line + 1 })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { literals, patterns, calls }
}

export function checkExtensions(root, sdk, allow) {
  const problems = []
  const extensions = []
  for (const id of extensionIds(root)) {
    const dir = join(root, EXTENSIONS_DIR, id)
    const where = `${EXTENSIONS_DIR}/${id}`
    const raw = readJson(join(dir, 'ostia.json'))
    const parsed = sdk.parseManifest(raw, dir)
    if (!parsed.ok) {
      problems.push(`extension: ${id}: ${parsed.error}. Fix ${where}/ostia.json.`)
      continue
    }
    const manifest = parsed.manifest
    const english = readJson(join(dir, 'locales', `${BASE_LANGUAGE}.json`))
    const messages = flatten(english?.messages ?? {})
    const source = new Map([
      ...[...sdk.manifestSlots(manifest)].filter(([key]) => shownToHumans(raw)(key)).map(([key, slot]) => [`manifest.${key}`, slot.text]),
      ...[...messages].map(([key, text]) => [`messages.${key}`, text]),
    ])
    const usage = sourceFiles(dir).map((file) => ({ file, ...scanUsage(file) }))
    const translated = (manifest.locales ?? []).map((tag) => ({ tag, catalog: readJson(join(dir, 'locales', `${tag}.json`)) ?? {} }))
    const hasMessages = translated.some(({ catalog }) => Object.keys(catalog.messages ?? {}).length > 0)
    const calls = usage.flatMap(({ file, calls }) => calls.map((call) => ({ ...call, file })))
    if (!english && (hasMessages || calls.length > 0)) {
      problems.push(
        `extension: ${id} has messages but no ${where}/locales/${BASE_LANGUAGE}.json. Put the English messages there and read them with t().`,
      )
    }
    if (english) {
      for (const call of calls) {
        if (!messages.has(call.key)) {
          problems.push(
            `undefined: ${id} t('${call.key}') at ${where}/${call.file.slice(dir.length + 1)}:${call.line}: no English message. Add it to ${where}/locales/${BASE_LANGUAGE}.json.`,
          )
        }
      }
      for (const key of messages.keys()) {
        const reached = usage.some(
          ({ literals, patterns }) => literals.has(key) || patterns.some((pattern) => pattern.test(key)),
        )
        if (!reached && !allow.unused(`${id}:${key}`)) {
          problems.push(
            `unused: ${id} message ${key}: no code reads it. Remove it from ${where}/locales/*.json.`,
          )
        }
      }
    }
    const results = translated.map(({ tag, catalog }) => {
      const target = new Map([
        ...Object.entries(catalog.manifest ?? {}).filter(([key]) => shownToHumans(raw)(key)).map(([key, text]) => [`manifest.${key}`, text]),
        ...[...flatten(catalog.messages ?? {})].map(([key, text]) => [`messages.${key}`, text]),
      ])
      const result = compareCatalog({
        source,
        target,
        scope: `${id}:${tag}`,
        label: `${id} ${tag}`,
        fileOf: () => `${where}/locales/${tag}.json`,
        allow,
      })
      problems.push(...result.problems)
      return { language: tag, rows: result.rows }
    })
    extensions.push({ id, results })
  }
  return { problems, extensions }
}
