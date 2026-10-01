import type { ModelMessage, ToolResultPart } from 'ai'
import { z } from 'zod'
import {
  COMMAND_SUGGESTIONS_MAX,
  COMPLETION_TEXT_MAX,
  type ChatAssistRequest,
  type ChatToolCall,
  type CommandAssistRequest,
  type CommandSuggestion,
  type CompletionAssistRequest,
  type PromptReview,
  REVIEW_NOTES_MAX,
  TERMINAL_COMPLETION_MAX,
  type TerminalAssistRequest,
} from '../../../shared/assist'
import { PRODUCT_NAME } from '../../../shared/product'

export interface Prompt {
  system: string
  messages: ModelMessage[]
  temperature: number
  maxOutputTokens: number
}

const FAST_TEMPERATURE = 0.1

function user(content: string): ModelMessage[] {
  return [{ role: 'user', content }]
}

export function typoPrompt(text: string): Prompt {
  return {
    system: [
      'You fix spelling and typing mistakes in a message a developer is about to send to a coding agent.',
      'Change only misspelled words, doubled or swapped letters and obvious typos.',
      'Keep the wording, tone, language, punctuation and line breaks.',
      'Never change code, file paths, commands, flags, identifiers, URLs or anything in backticks.',
      'Reply with the corrected message only: no quotes, no explanations.',
      'If there is nothing to fix, reply with the message unchanged.',
    ].join(' '),
    messages: user(text),
    temperature: FAST_TEMPERATURE,
    maxOutputTokens: Math.min(4096, Math.ceil(text.length / 2) + 64),
  }
}

export function stripFences(raw: string): string {
  const trimmed = raw.trim()
  const fenced = /^```[\w-]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed)
  return fenced ? fenced[1] : trimmed
}

function unquote(text: string): string {
  const quoted = /^(["'`])([\s\S]*)\1$/.exec(text)
  return quoted && !text.startsWith('```') ? quoted[2] : text
}

export function parseCorrection(raw: string, original: string): string | null {
  const body = unquote(stripFences(raw))
  const core = original.trim()
  if (!body || body === core) return null
  if (body.length > core.length * 1.5 + 10 || body.length < core.length * 0.5) return null
  const lead = /^\s*/.exec(original)?.[0] ?? ''
  const trail = /\s*$/.exec(original)?.[0] ?? ''
  return `${lead}${body}${trail}`
}

export const reviewSchema = z.object({
  score: z.coerce.number(),
  notes: z.array(z.string()).default([]),
})

export function reviewPrompt(text: string, agent?: string): Prompt {
  const who = agent ? `the coding agent ${agent}` : 'a coding agent'
  return {
    system: [
      `You review a prompt a developer is about to send to ${who} working in their repository.`,
      'Judge whether the agent could act on it without guessing: a clear goal, the files or area',
      'involved, constraints, and how to tell it is done.',
      `Reply with JSON only: {"score": 1-5, "notes": ["..."]}, at most ${REVIEW_NOTES_MAX} notes,`,
      'each one short and actionable, naming what is missing or ambiguous.',
      'A score of 5 needs no notes. Do not rewrite the prompt.',
    ].join(' '),
    messages: user(text),
    temperature: FAST_TEMPERATURE,
    maxOutputTokens: 300,
  }
}

export function reviewFrom(parsed: z.infer<typeof reviewSchema>): PromptReview | null {
  const notes = parsed.notes
    .map((n) => n.trim())
    .filter((n) => n !== '')
    .slice(0, REVIEW_NOTES_MAX)
  const review: PromptReview = { notes }
  if (Number.isFinite(parsed.score)) {
    review.score = Math.min(5, Math.max(1, Math.round(parsed.score)))
  }
  return review.score === undefined && notes.length === 0 ? null : review
}

export const commandSchema = z.object({
  suggestions: z.array(
    z.object({
      command: z.string(),
      description: z.string().optional(),
    }),
  ),
})

export function commandPrompt(req: CommandAssistRequest): Prompt {
  const where = [
    req.shell ? `Shell: ${req.shell}` : null,
    req.platform ? `OS: ${req.platform}` : null,
    req.cwd ? `Working directory: ${req.cwd}` : null,
  ].filter((line): line is string => line !== null)
  return {
    system: [
      'You turn a request written in plain language into shell commands.',
      `Suggest up to ${COMMAND_SUGGESTIONS_MAX} alternatives, best first, each a single command line`,
      'the user can run as is, using common tools for the given OS and shell.',
      'Prefer safe, non-destructive forms. Use relative paths; the command runs in the working directory.',
      'Reply with JSON only: {"suggestions": [{"command": "...", "description": "..."}]},',
      'where description is a few words.',
    ].join(' '),
    messages: user([...where, `Request: ${req.query}`].join('\n')),
    temperature: FAST_TEMPERATURE,
    maxOutputTokens: 300,
  }
}

export function commandsFrom(parsed: z.infer<typeof commandSchema>): CommandSuggestion[] {
  const out: CommandSuggestion[] = []
  for (const item of parsed.suggestions) {
    const command = item.command.trim()
    if (!command || command.includes('\n') || out.some((s) => s.command === command)) continue
    const suggestion: CommandSuggestion = { command }
    const description = item.description?.trim()
    if (description) suggestion.description = description
    out.push(suggestion)
    if (out.length === COMMAND_SUGGESTIONS_MAX) break
  }
  return out
}

const COMPLETION_EXAMPLES: [CompletionAssistRequest, string][] = [
  [
    {
      path: '/project/src/shapes.ts',
      language: 'typescript',
      prefix: 'export function area(width: number, height: number): number {\n  const size = ',
      suffix: '\n  return size\n}\n',
    },
    'width * height',
  ],
  [
    {
      path: '/project/greet.py',
      language: 'python',
      prefix: 'def greet(name):\n    ',
      suffix: '\n\n\nprint(greet("Ada"))\n',
    },
    'return f"Hello, {name}!"',
  ],
]

function completionMessage(req: CompletionAssistRequest): string {
  const neighbors = (req.neighbors ?? []).map(
    (n) => `Other open file ${n.path}:\n<file>${n.text}</file>`,
  )
  return [
    ...neighbors,
    `File ${req.path} (${req.language})`,
    `<prefix>${req.prefix}</prefix>`,
    `<suffix>${req.suffix}</suffix>`,
  ].join('\n')
}

export function completionPrompt(req: CompletionAssistRequest): Prompt {
  const examples: ModelMessage[] = COMPLETION_EXAMPLES.flatMap(([ask, answer]) => [
    { role: 'user' as const, content: completionMessage(ask) },
    { role: 'assistant' as const, content: answer },
  ])
  return {
    system: [
      'You fill in the middle of a file in a code editor.',
      'The user sends the code before the cursor in <prefix> and the code after it in <suffix>.',
      'Reply with only the text that goes between them, so prefix + reply + suffix is the',
      'finished code: start exactly where the prefix stops, even in the middle of a line,',
      'and never repeat code from the prefix or the suffix.',
      'Indent new lines the way the file does. Complete the current statement or the next few',
      'lines at most. No explanations, no code fences, no tags. Reply with nothing if unsure.',
    ].join(' '),
    messages: [...examples, ...user(completionMessage(req))],
    temperature: FAST_TEMPERATURE,
    maxOutputTokens: 200,
  }
}

const ECHO_MIN = 3
const CLOSER = /^[\])}]/

function squash(text: string): string {
  return text.replace(/\s+/g, '')
}

function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? ''
}

function afterEcho(line: string, echo: string): string | null {
  let i = 0
  for (const ch of squash(echo)) {
    while (i < line.length && /\s/.test(line[i])) i++
    if (line[i] !== ch) return null
    i++
  }
  return line.slice(i)
}

interface Indent {
  from: string
  to: string
}

function reindent(line: string, map: Indent): string {
  if (!line.trim()) return ''
  if (line.startsWith(map.from)) return map.to + line.slice(map.from.length)
  const indent = indentOf(line)
  const keep = Math.max(0, map.to.length - (map.from.length - indent.length))
  return map.to.slice(0, keep) + line.slice(indent.length)
}

function echoedLines(out: string[], prefixLines: string[]): number {
  const cursorAt = prefixLines.length - 1
  const cursorLine = prefixLines[cursorAt]
  const squashed = prefixLines.map(squash)
  const outSquashed = out.map(squash)
  for (let start = 0; start < cursorAt; start++) {
    const count = cursorAt - start
    if (out.length < count) continue
    let size = squashed[cursorAt].length
    let same = true
    for (let i = 0; i < count && same; i++) {
      same = outSquashed[i] === squashed[start + i]
      size += squashed[start + i].length
    }
    if (same && size >= ECHO_MIN && afterEcho(out[count] ?? '', cursorLine) !== null) return count
  }
  return 0
}

function cursorEcho(line: string, cursorLine: string): string | null {
  if (cursorLine && line.startsWith(cursorLine)) return line.slice(cursorLine.length)
  const size = squash(cursorLine).length
  if (size === 0) return cursorLine ? line : null
  return size >= ECHO_MIN ? afterEcho(line, cursorLine) : null
}

function partialEcho(line: string, cursorLine: string): string | null {
  for (let j = indentOf(cursorLine).length + 1; j < cursorLine.length; j++) {
    if (!/\s/.test(cursorLine[j - 1]) || /\s/.test(cursorLine[j])) continue
    const tail = cursorLine.slice(j)
    if (squash(tail).length < ECHO_MIN) return null
    const rest = afterEcho(line, tail)
    if (rest !== null) return rest
  }
  return null
}

function guessIndent(rest: string[], cursorLine: string): Indent {
  const cursorIndent = indentOf(cursorLine)
  const first = rest.find((l) => l.trim())
  const flush = first !== undefined && indentOf(first) === '' && !CLOSER.test(first)
  return flush && cursorIndent && cursorLine.trim()
    ? { from: '', to: cursorIndent }
    : { from: '', to: '' }
}

function dropEchoAndIndent(text: string, prefix: string): string {
  const prefixLines = prefix.split('\n')
  const cursorLine = prefixLines[prefixLines.length - 1]
  const out = text.split('\n')
  const skipped = echoedLines(out, prefixLines)
  const line = out[skipped] ?? ''
  const rest = out.slice(skipped + 1)
  const echoed = skipped > 0 ? afterEcho(line, cursorLine) : cursorEcho(line, cursorLine)
  let head: string
  let map: Indent
  if (echoed !== null && cursorLine !== '') {
    map = { from: indentOf(line), to: indentOf(cursorLine) }
    head = squash(cursorLine) === '' ? reindent(line, map).slice(cursorLine.length) : echoed
  } else if (echoed !== null && skipped > 0) {
    map = { from: indentOf(out[0]), to: indentOf(prefixLines[prefixLines.length - 1 - skipped]) }
    head = reindent(line, map)
  } else {
    head = partialEcho(line, cursorLine) ?? line
    map = guessIndent(rest, cursorLine)
  }
  if (/\s$/.test(cursorLine)) head = head.replace(/^[ \t]+/, '')
  return [head, ...rest.map((l) => reindent(l, map))].join('\n')
}

function dropSuffixLines(text: string, suffix: string): string {
  const lines = text.split('\n')
  const ahead = suffix
    .split('\n')
    .slice(1)
    .map(squash)
    .filter((l) => l !== '')
  for (let i = 1; i < lines.length; i++) {
    const tail = lines
      .slice(i)
      .map(squash)
      .filter((l) => l !== '')
    if (tail.length === 0 || tail.length > ahead.length) continue
    const same = tail.every((l, k) => l === ahead[k])
    if (same && tail.join('').length >= ECHO_MIN) return lines.slice(0, i).join('\n')
  }
  return text
}

const OPENER_OF: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

function closesMoreThanOpens(text: string, closer: string): boolean {
  const opener = OPENER_OF[closer]
  if (!opener) return true
  let depth = 0
  for (const ch of text) {
    if (ch === opener) depth++
    else if (ch === closer) depth--
  }
  return depth < 0
}

function dropSuffixOverlap(text: string, suffix: string): string {
  const head = suffix.replace(/^\s+/, '')
  if (!head) return text
  const trimmed = text.replace(/\s+$/, '')
  for (let n = Math.min(trimmed.length, head.length); n > 0; n--) {
    const tail = trimmed.slice(trimmed.length - n)
    if (head.startsWith(tail) && /^\S/.test(tail) && closesMoreThanOpens(trimmed, tail[0])) {
      const before = trimmed.slice(0, trimmed.length - n)
      if (before === '' || /\s$/.test(before) || /^[\])};,]/.test(tail)) return before
    }
  }
  return text
}

export function cleanCompletion(raw: string, prefix: string, suffix: string): string {
  let text = raw
    .replace(/\r\n/g, '\n')
    .replace(/^```[\w-]*\n/, '')
    .replace(/\n?```\s*$/, '')
    .replace(/<\/?(?:prefix|suffix|middle|cursor)>/gi, '')
  text = dropEchoAndIndent(text, prefix)
  text = dropSuffixLines(text, suffix)
  text = dropSuffixOverlap(text, suffix)
  text = dropUnopenedClosers(text.replace(/\s+$/, ''), prefix)
  return text.slice(0, COMPLETION_TEXT_MAX)
}

function dropUnopenedClosers(text: string, prefix: string): string {
  let out = text
  for (const closer of [')', ']']) {
    let extra = 0
    while (out.endsWith(closer) && closesMoreThanOpens(prefix + out, closer) && extra < 8) {
      out = out.slice(0, -1).replace(/\s+$/, '')
      extra++
    }
  }
  return out
}

const TERMINAL_EXAMPLES: [string, string][] = [
  ['Current line: git chec', 'git checkout main'],
  ['Current line: ls -', 'ls -la'],
  ['Current line: docker ps ', 'docker ps -a'],
]

export function terminalPrompt(req: TerminalAssistRequest): Prompt {
  const history = (req.history ?? []).map((h) =>
    h.exitCode === undefined ? `$ ${h.command}` : `$ ${h.command}   # exit ${h.exitCode}`,
  )
  const context = (req.context ?? []).map((c) => `${c.label}: ${c.text}`)
  const lines = [
    req.shell ? `Shell: ${req.shell}` : null,
    req.platform ? `OS: ${req.platform}` : null,
    req.cwd ? `Working directory: ${req.cwd}` : null,
    ...context,
    history.length > 0 ? `Recent commands:\n${history.join('\n')}` : null,
    `Current line: ${req.line}`,
  ].filter((line): line is string => line !== null)
  const examples: ModelMessage[] = TERMINAL_EXAMPLES.flatMap(([ask, answer]) => [
    { role: 'user' as const, content: ask },
    { role: 'assistant' as const, content: answer },
  ])
  return {
    system: [
      'You autocomplete the command a developer is typing at a shell prompt.',
      'Reply with the whole command line as it most likely ends: it must start with exactly',
      'the current line, stay one line, and add only what completes this one command.',
      'No explanation, no quotes, no code fences. Reply with the current line unchanged if unsure.',
    ].join(' '),
    messages: [...examples, ...user(lines.join('\n'))],
    temperature: 0,
    maxOutputTokens: 48,
  }
}

export function cleanTerminal(raw: string, line: string): string {
  const body = raw.trim().startsWith('```') ? stripFences(raw) : raw.replace(/^\s*\n/, '')
  const full = unquote((body.split(/\r?\n/)[0] ?? '').trim()).replace(/^\$\s+/, '')
  if (!full.startsWith(line.trimStart())) return ''
  const rest = full.slice(line.trimStart().length).replace(/\s+$/, '')
  return rest.trim() ? rest.slice(0, TERMINAL_COMPLETION_MAX) : ''
}

export function chatSystem(req: ChatAssistRequest): string {
  const base = [
    `You are the assistant built into ${PRODUCT_NAME}, a terminal workspace where developers run shells and coding agents.`,
    'Answer like an expert peer: direct and short, no filler.',
    'Put every command or code in a fenced block with a language tag (```sh for shell commands),',
    'one command per block when the user may want to run it.',
    'Never claim you ran anything; the user decides what to run.',
  ].join(' ')
  const tools = req.tools?.length
    ? [
        base,
        'You can call tools. Read-only tools run right away; tools that change something wait for the user to approve them in the chat, and a denied call means the user said no: do not retry it.',
        'Propose shell commands with the propose_command tool when it is available instead of claiming to run them.',
      ].join(' ')
    : base
  const sections = req.context.map(
    (item) => `## ${item.label} (${item.kind})\n\`\`\`\n${item.text}\n\`\`\``,
  )
  return sections.length > 0
    ? `${tools}\n\nContext the user shared:\n\n${sections.join('\n\n')}`
    : tools
}

const DENIED_REASON = 'The user denied this tool call.'

function toolResult(call: ChatToolCall): ToolResultPart['output'] {
  if (call.state === 'done') return { type: 'text', value: call.output ?? '' }
  if (call.state === 'error') return { type: 'error-text', value: call.error ?? 'failed' }
  return { type: 'execution-denied', reason: DENIED_REASON }
}

export function chatMessages(req: ChatAssistRequest): ModelMessage[] {
  const out: ModelMessage[] = []
  for (const m of req.messages) {
    if (m.role === 'user' || !m.tools?.length) {
      out.push({ role: m.role, content: m.content })
      continue
    }
    out.push({
      role: 'assistant',
      content: [
        ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
        ...m.tools.map((call) => ({
          type: 'tool-call' as const,
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
        })),
      ],
    })
    out.push({
      role: 'tool',
      content: m.tools.map((call) => ({
        type: 'tool-result' as const,
        toolCallId: call.id,
        toolName: call.name,
        output: toolResult(call),
      })),
    })
  }
  return out
}

export function chatPrompt(req: ChatAssistRequest): Prompt {
  return {
    system: chatSystem(req),
    messages: chatMessages(req),
    temperature: 0.3,
    maxOutputTokens: 2048,
  }
}
