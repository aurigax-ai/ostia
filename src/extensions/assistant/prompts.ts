import {
  COMMAND_SUGGESTIONS_MAX,
  COMPLETION_TEXT_MAX,
  type ChatAssistRequest,
  type CommandAssistRequest,
  type CommandSuggestion,
  type CompletionAssistRequest,
  type PromptReview,
  REVIEW_NOTES_MAX,
} from '../../shared/assist'
import { PRODUCT_NAME } from '../../shared/product'
import type { PromptMessage } from './providers'

export interface Prompt {
  system: string
  messages: PromptMessage[]
  temperature: number
  maxTokens: number
}

const FAST_TEMPERATURE = 0.1

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
    messages: [{ role: 'user', content: text }],
    temperature: FAST_TEMPERATURE,
    maxTokens: Math.min(4096, Math.ceil(text.length / 2) + 64),
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
    messages: [{ role: 'user', content: text }],
    temperature: FAST_TEMPERATURE,
    maxTokens: 400,
  }
}

function firstJson(raw: string): unknown {
  const body = stripFences(raw)
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = body.indexOf(open)
    const end = body.lastIndexOf(close)
    if (start === -1 || end <= start) continue
    try {
      return JSON.parse(body.slice(start, end + 1))
    } catch {}
  }
  return null
}

export function parseReview(raw: string): PromptReview | null {
  const parsed = firstJson(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const { score, notes } = parsed as { score?: unknown; notes?: unknown }
  const review: PromptReview = {
    notes: Array.isArray(notes)
      ? notes
          .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
          .map((n) => n.trim())
          .slice(0, REVIEW_NOTES_MAX)
      : [],
  }
  const n = typeof score === 'string' ? Number(score) : score
  if (typeof n === 'number' && Number.isFinite(n)) {
    review.score = Math.min(5, Math.max(1, Math.round(n)))
  }
  return review.score === undefined && review.notes.length === 0 ? null : review
}

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
      'Prefer safe, non-destructive forms.',
      'Reply with JSON only: {"suggestions": [{"command": "...", "description": "..."}]},',
      'where description is a few words.',
    ].join(' '),
    messages: [{ role: 'user', content: [...where, `Request: ${req.query}`].join('\n') }],
    temperature: FAST_TEMPERATURE,
    maxTokens: 400,
  }
}

export function parseCommands(raw: string): CommandSuggestion[] {
  const parsed = firstJson(raw)
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null
      ? (parsed as { suggestions?: unknown }).suggestions
      : null
  if (!Array.isArray(list)) return []
  const out: CommandSuggestion[] = []
  for (const item of list) {
    const entry = typeof item === 'string' ? { command: item } : item
    if (typeof entry !== 'object' || entry === null) continue
    const command = (entry as { command?: unknown }).command
    if (typeof command !== 'string' || !command.trim() || command.includes('\n')) continue
    const suggestion: CommandSuggestion = { command: command.trim() }
    const description = (entry as { description?: unknown }).description
    if (typeof description === 'string' && description.trim()) {
      suggestion.description = description.trim()
    }
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
    messages: [
      {
        role: 'user',
        content: [
          ...neighbors,
          `File ${req.path} (${req.language}):`,
          `<code>\n${req.prefix}${CURSOR_MARK}${req.suffix}\n</code>`,
        ].join('\n\n'),
      },
    ],
    temperature: FAST_TEMPERATURE,
    maxTokens: 256,
  }
}

export function cleanCompletion(raw: string, prefix: string, suffix: string): string {
  let text = raw.replace(/^```[\w-]*\r?\n/, '').replace(/\r?\n?```\s*$/, '')
  text = text.split(CURSOR_MARK).join('')
  const lastLine = prefix.slice(prefix.lastIndexOf('\n') + 1)
  if (lastLine.trim() && text.startsWith(lastLine)) text = text.slice(lastLine.length)
  const nextLine = suffix.split('\n')[0]
  if (nextLine.trim() && text.endsWith(nextLine)) text = text.slice(0, -nextLine.length)
  text = text.replace(/\s+$/, '')
  return text.slice(0, COMPLETION_TEXT_MAX)
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
    messages: req.messages,
    temperature: 0.3,
    maxTokens: 2048,
  }
}
