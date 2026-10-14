export interface SnippetArgument {
  name: string
  description?: string
  defaultValue?: string
}

export interface Snippet {
  name: string
  command: string
  description?: string
  tags: string[]
  arguments: SnippetArgument[]
  shells?: string[]
  author?: string
  sourceUrl?: string
}

export type SnippetSource = 'workspace' | 'user' | 'extension'

export interface SnippetEntry extends Snippet {
  source: SnippetSource
  origin: string
}

export interface SnippetProblem {
  source: SnippetSource
  origin: string
  error: string
}

export interface SnippetListing {
  snippets: SnippetEntry[]
  problems: SnippetProblem[]
}

export interface SnippetDocument {
  name: string
  command: string
  description?: string
  tags?: string[]
  arguments?: { name: string; description?: string; default_value?: string }[]
  shells?: string[]
  author?: string
  source_url?: string
}

export type SnippetSaveResult = { ok: true; file: string } | { ok: false; error: string }

export type CommandPart = { text: string } | { arg: string }

export const SNIPPET_LIMITS = {
  name: 200,
  command: 8192,
  description: 1000,
  tags: 32,
  tag: 64,
  arguments: 32,
  argumentDescription: 500,
  defaultValue: 1000,
  shells: 8,
  author: 200,
  sourceUrl: 2000,
} as const

export const ARGUMENT_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/

const PLACEHOLDER = /\{\{\{([^{}]+)\}\}\}|\{\{([A-Za-z_][A-Za-z0-9_-]{0,63})\}\}/g

export function commandParts(command: string): CommandPart[] {
  const parts: CommandPart[] = []
  let text = ''
  let last = 0
  for (const match of command.matchAll(PLACEHOLDER)) {
    text += command.slice(last, match.index)
    last = match.index + match[0].length
    if (match[1] !== undefined) {
      text += `{{${match[1]}}}`
      continue
    }
    if (text) parts.push({ text })
    text = ''
    parts.push({ arg: match[2] })
  }
  text += command.slice(last)
  if (text) parts.push({ text })
  return parts
}

export function placeholderNames(command: string): string[] {
  const names: string[] = []
  for (const part of commandParts(command)) {
    if ('arg' in part && !names.includes(part.arg)) names.push(part.arg)
  }
  return names
}

export function snippetArguments(snippet: Snippet): SnippetArgument[] {
  return placeholderNames(snippet.command).map(
    (name) => snippet.arguments.find((a) => a.name === name) ?? { name },
  )
}

export function renderSnippet(command: string, values: Readonly<Record<string, string>>): string {
  return commandParts(command)
    .map((part) => ('arg' in part ? (values[part.arg] ?? '') : part.text))
    .join('')
}

export function defaultValues(snippet: Snippet): Record<string, string> {
  return Object.fromEntries(snippetArguments(snippet).map((a) => [a.name, a.defaultValue ?? '']))
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function optionalText(v: unknown, max: number, field: string): string | undefined | Error {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') return new Error(`${field} must be a string`)
  if (v.length > max) return new Error(`${field} is longer than ${max} characters`)
  return v.trim() ? v : undefined
}

function scalarText(v: unknown, max: number, field: string): string | undefined | Error {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return optionalText(v, max, field)
}

function textList(v: unknown, count: number, max: number, field: string): string[] | Error {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.length > count) {
    return new Error(`${field} must be a list of at most ${count} strings`)
  }
  const out: string[] = []
  for (const item of v) {
    if (typeof item !== 'string' || !item.trim() || item.length > max) {
      return new Error(`${field} must hold non-empty strings of at most ${max} characters`)
    }
    if (!out.includes(item.trim())) out.push(item.trim())
  }
  return out
}

function parseArgument(raw: unknown, index: number): SnippetArgument | Error {
  const where = `arguments[${index}]`
  if (!isRecord(raw)) return new Error(`${where} must be a mapping`)
  if (typeof raw.name !== 'string' || !ARGUMENT_NAME.test(raw.name)) {
    return new Error(`${where}.name must be letters, digits, _ or -`)
  }
  const arg: SnippetArgument = { name: raw.name }
  const description = optionalText(
    raw.description,
    SNIPPET_LIMITS.argumentDescription,
    `${where}.description`,
  )
  if (description instanceof Error) return description
  if (description) arg.description = description
  const value = scalarText(raw.default_value, SNIPPET_LIMITS.defaultValue, `${where}.default_value`)
  if (value instanceof Error) return value
  if (value !== undefined) arg.defaultValue = value
  return arg
}

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

export function parseSnippet(raw: unknown): Snippet | Error {
  if (!isRecord(raw)) return new Error('a snippet must be a mapping')
  const name = optionalText(raw.name, SNIPPET_LIMITS.name, 'name')
  if (name instanceof Error) return name
  if (!name) return new Error('missing name')
  const command = optionalText(raw.command, SNIPPET_LIMITS.command, 'command')
  if (command instanceof Error) return command
  if (!command) return new Error('missing command')
  const snippet: Snippet = { name: name.trim(), command, tags: [], arguments: [] }

  const description = optionalText(raw.description, SNIPPET_LIMITS.description, 'description')
  if (description instanceof Error) return description
  if (description) snippet.description = description.trim()

  const tags = textList(raw.tags, SNIPPET_LIMITS.tags, SNIPPET_LIMITS.tag, 'tags')
  if (tags instanceof Error) return tags
  snippet.tags = tags

  const rawArgs = raw.arguments ?? []
  if (!Array.isArray(rawArgs) || rawArgs.length > SNIPPET_LIMITS.arguments) {
    return new Error(`arguments must be a list of at most ${SNIPPET_LIMITS.arguments}`)
  }
  for (const [i, item] of rawArgs.entries()) {
    const arg = parseArgument(item, i)
    if (arg instanceof Error) return arg
    if (snippet.arguments.some((a) => a.name === arg.name)) {
      return new Error(`duplicate argument '${arg.name}'`)
    }
    snippet.arguments.push(arg)
  }

  const shells = textList(raw.shells, SNIPPET_LIMITS.shells, SNIPPET_LIMITS.tag, 'shells')
  if (shells instanceof Error) return shells
  if (shells.length > 0) snippet.shells = shells

  const author = optionalText(raw.author, SNIPPET_LIMITS.author, 'author')
  if (author instanceof Error) return author
  if (author) snippet.author = author.trim()

  const sourceUrl = optionalText(raw.source_url, SNIPPET_LIMITS.sourceUrl, 'source_url')
  if (sourceUrl instanceof Error) return sourceUrl
  if (sourceUrl) {
    if (!isWebUrl(sourceUrl.trim())) return new Error('source_url must be an http(s) URL')
    snippet.sourceUrl = sourceUrl.trim()
  }
  return snippet
}

export function snippetDocument(snippet: Snippet): SnippetDocument {
  const doc: SnippetDocument = { name: snippet.name, command: snippet.command }
  if (snippet.description) doc.description = snippet.description
  if (snippet.tags.length > 0) doc.tags = [...snippet.tags]
  if (snippet.arguments.length > 0) {
    doc.arguments = snippet.arguments.map((a) => {
      const arg: { name: string; description?: string; default_value?: string } = { name: a.name }
      if (a.description) arg.description = a.description
      if (a.defaultValue !== undefined) arg.default_value = a.defaultValue
      return arg
    })
  }
  if (snippet.shells) doc.shells = [...snippet.shells]
  if (snippet.author) doc.author = snippet.author
  if (snippet.sourceUrl) doc.source_url = snippet.sourceUrl
  return doc
}

export function snippetFileStem(name: string): string {
  const stem = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return stem || 'snippet'
}
