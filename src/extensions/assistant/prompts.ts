import type { ModelMessage } from 'ai'
import { z } from 'zod'
import {
  COMMAND_SUGGESTIONS_MAX,
  COMPLETION_TEXT_MAX,
  type ChatAssistRequest,
  type CommandAssistRequest,
  type CommandSuggestion,
  type CompletionAssistRequest,
  type PromptReview,
  REVIEW_NOTES_MAX,
  TERMINAL_COMPLETION_MAX,
  type TerminalAssistRequest,
} from '../../shared/assist'
import { PRODUCT_NAME } from '../../shared/product'

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

export const CURSOR_MARK = '<CURSOR>'

export function completionPrompt(req: CompletionAssistRequest): Prompt {
  const neighbors = (req.neighbors ?? []).map(
    (n) => `Other open file ${n.path}:\n<file>\n${n.text}\n</file>`,
  )
  return {
    system: [
      'You are a code completion engine inside an editor.',
      `Output only the text to insert at ${CURSOR_MARK}: no explanations, no code fences,`,
      'and never repeat the code before or after the cursor.',
      'Complete the current statement or the next few lines at most.',
      'Output nothing if no completion fits.',
    ].join(' '),
    messages: user(
      [
        ...neighbors,
        `File ${req.path} (${req.language}):`,
        `<code>\n${req.prefix}${CURSOR_MARK}${req.suffix}\n</code>`,
      ].join('\n\n'),
    ),
    temperature: FAST_TEMPERATURE,
    maxOutputTokens: 200,
  }
}

function dropRepeatedIndent(text: string, prefix: string): string {
  const indent = /[ \t]+$/.exec(prefix.slice(prefix.lastIndexOf('\n') + 1))?.[0]
  if (!indent || prefix.slice(prefix.lastIndexOf('\n') + 1) !== indent) return text
  return text.startsWith(indent) ? text.slice(indent.length) : text.replace(/^[ \t]+/, '')
}

function dropSuffixOverlap(text: string, suffix: string): string {
  const head = suffix.replace(/^\s+/, '')
  if (!head) return text
  const trimmed = text.replace(/\s+$/, '')
  for (let n = Math.min(trimmed.length, head.length); n > 0; n--) {
    const tail = trimmed.slice(trimmed.length - n)
    if (head.startsWith(tail) && /^\S/.test(tail)) {
      const before = trimmed.slice(0, trimmed.length - n)
      if (before === '' || /\s$/.test(before) || /^[\])};,]/.test(tail)) return before
    }
  }
  return text
}

export function cleanCompletion(raw: string, prefix: string, suffix: string): string {
  let text = raw.replace(/^```[\w-]*\r?\n/, '').replace(/\r?\n?```\s*$/, '')
  text = text.split(CURSOR_MARK).join('')
  const lastLine = prefix.slice(prefix.lastIndexOf('\n') + 1)
  if (lastLine.trim() && text.startsWith(lastLine)) text = text.slice(lastLine.length)
  text = dropRepeatedIndent(text, prefix)
  text = dropSuffixOverlap(text, suffix)
  text = text.replace(/\s+$/, '')
  return text.slice(0, COMPLETION_TEXT_MAX)
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
  const sections = req.context.map(
    (item) => `## ${item.label} (${item.kind})\n\`\`\`\n${item.text}\n\`\`\``,
  )
  return sections.length > 0
    ? `${base}\n\nContext the user shared:\n\n${sections.join('\n\n')}`
    : base
}

export function chatPrompt(req: ChatAssistRequest): Prompt {
  return {
    system: chatSystem(req),
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: 0.3,
    maxOutputTokens: 2048,
  }
}
