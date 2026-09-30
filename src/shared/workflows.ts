export interface WorkflowArgument {
  name: string
  description?: string
  defaultValue?: string
}

export interface Workflow {
  name: string
  command: string
  description?: string
  tags: string[]
  arguments: WorkflowArgument[]
  shells?: string[]
  author?: string
  sourceUrl?: string
}

export type WorkflowSource = 'workspace' | 'user' | 'extension'

export interface WorkflowEntry extends Workflow {
  source: WorkflowSource
  origin: string
}

export interface WorkflowProblem {
  source: WorkflowSource
  origin: string
  error: string
}

export interface WorkflowListing {
  workflows: WorkflowEntry[]
  problems: WorkflowProblem[]
}

export interface WorkflowDocument {
  name: string
  command: string
  description?: string
  tags?: string[]
  arguments?: { name: string; description?: string; default_value?: string }[]
  shells?: string[]
  author?: string
  source_url?: string
}

export type WorkflowSaveResult = { ok: true; file: string } | { ok: false; error: string }

export type CommandPart = { text: string } | { arg: string }

export const WORKFLOW_LIMITS = {
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

export function workflowArguments(workflow: Workflow): WorkflowArgument[] {
  return placeholderNames(workflow.command).map(
    (name) => workflow.arguments.find((a) => a.name === name) ?? { name },
  )
}

export function renderWorkflow(command: string, values: Readonly<Record<string, string>>): string {
  return commandParts(command)
    .map((part) => ('arg' in part ? (values[part.arg] ?? '') : part.text))
    .join('')
}

export function defaultValues(workflow: Workflow): Record<string, string> {
  return Object.fromEntries(workflowArguments(workflow).map((a) => [a.name, a.defaultValue ?? '']))
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

function parseArgument(raw: unknown, index: number): WorkflowArgument | Error {
  const where = `arguments[${index}]`
  if (!isRecord(raw)) return new Error(`${where} must be a mapping`)
  if (typeof raw.name !== 'string' || !ARGUMENT_NAME.test(raw.name)) {
    return new Error(`${where}.name must be letters, digits, _ or -`)
  }
  const arg: WorkflowArgument = { name: raw.name }
  const description = optionalText(
    raw.description,
    WORKFLOW_LIMITS.argumentDescription,
    `${where}.description`,
  )
  if (description instanceof Error) return description
  if (description) arg.description = description
  const value = scalarText(
    raw.default_value,
    WORKFLOW_LIMITS.defaultValue,
    `${where}.default_value`,
  )
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

export function parseWorkflow(raw: unknown): Workflow | Error {
  if (!isRecord(raw)) return new Error('a workflow must be a mapping')
  const name = optionalText(raw.name, WORKFLOW_LIMITS.name, 'name')
  if (name instanceof Error) return name
  if (!name) return new Error('missing name')
  const command = optionalText(raw.command, WORKFLOW_LIMITS.command, 'command')
  if (command instanceof Error) return command
  if (!command) return new Error('missing command')
  const workflow: Workflow = { name: name.trim(), command, tags: [], arguments: [] }

  const description = optionalText(raw.description, WORKFLOW_LIMITS.description, 'description')
  if (description instanceof Error) return description
  if (description) workflow.description = description.trim()

  const tags = textList(raw.tags, WORKFLOW_LIMITS.tags, WORKFLOW_LIMITS.tag, 'tags')
  if (tags instanceof Error) return tags
  workflow.tags = tags

  const rawArgs = raw.arguments ?? []
  if (!Array.isArray(rawArgs) || rawArgs.length > WORKFLOW_LIMITS.arguments) {
    return new Error(`arguments must be a list of at most ${WORKFLOW_LIMITS.arguments}`)
  }
  for (const [i, item] of rawArgs.entries()) {
    const arg = parseArgument(item, i)
    if (arg instanceof Error) return arg
    if (workflow.arguments.some((a) => a.name === arg.name)) {
      return new Error(`duplicate argument '${arg.name}'`)
    }
    workflow.arguments.push(arg)
  }

  const shells = textList(raw.shells, WORKFLOW_LIMITS.shells, WORKFLOW_LIMITS.tag, 'shells')
  if (shells instanceof Error) return shells
  if (shells.length > 0) workflow.shells = shells

  const author = optionalText(raw.author, WORKFLOW_LIMITS.author, 'author')
  if (author instanceof Error) return author
  if (author) workflow.author = author.trim()

  const sourceUrl = optionalText(raw.source_url, WORKFLOW_LIMITS.sourceUrl, 'source_url')
  if (sourceUrl instanceof Error) return sourceUrl
  if (sourceUrl) {
    if (!isWebUrl(sourceUrl.trim())) return new Error('source_url must be an http(s) URL')
    workflow.sourceUrl = sourceUrl.trim()
  }
  return workflow
}

export function workflowDocument(workflow: Workflow): WorkflowDocument {
  const doc: WorkflowDocument = { name: workflow.name, command: workflow.command }
  if (workflow.description) doc.description = workflow.description
  if (workflow.tags.length > 0) doc.tags = [...workflow.tags]
  if (workflow.arguments.length > 0) {
    doc.arguments = workflow.arguments.map((a) => {
      const arg: { name: string; description?: string; default_value?: string } = { name: a.name }
      if (a.description) arg.description = a.description
      if (a.defaultValue !== undefined) arg.default_value = a.defaultValue
      return arg
    })
  }
  if (workflow.shells) doc.shells = [...workflow.shells]
  if (workflow.author) doc.author = workflow.author
  if (workflow.sourceUrl) doc.source_url = workflow.sourceUrl
  return doc
}

export function workflowFileStem(name: string): string {
  const stem = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return stem || 'workflow'
}
