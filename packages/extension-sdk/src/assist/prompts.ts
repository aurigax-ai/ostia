import type { ModelMessage, ToolResultPart } from 'ai'
import { z } from 'zod'
import {
  type ChatAssistRequest,
  type ChatContextItem,
  type ChatToolCall,
  COMMAND_SUGGESTIONS_MAX,
  type CommandAssistRequest,
  type CommandSuggestion,
  type CompletionAssistRequest,
  type PromptReview,
  REVIEW_NOTES_MAX,
  TERMINAL_COMPLETION_MAX,
  type TerminalAssistRequest,
} from '../contract/assist'
import { PRODUCT_NAME } from '../contract/product'

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

function stripFences(raw: string): string {
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
  const trail = original.slice(original.trimEnd().length)
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
  const rest = full.slice(line.trimStart().length).trimEnd()
  return rest.trim() ? rest.slice(0, TERMINAL_COMPLETION_MAX) : ''
}

function contextSection(item: ChatContextItem): string {
  const lines =
    item.startLine === undefined
      ? ''
      : item.startLine === item.endLine
        ? `, line ${item.startLine}`
        : `, lines ${item.startLine}-${item.endLine}`
  const where = item.path ? `File: ${item.path}${lines}\n` : ''
  return `## ${item.label} (${item.kind})\n${where}\`\`\`\n${item.text}\n\`\`\``
}

function chatSystem(req: ChatAssistRequest): string {
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
        'To change a file, call edit_file with the exact text to replace and its replacement; read the file first unless the user shared that part of it. Use write_file only for a new file or a full rewrite. Never paste a whole changed file into your answer when an edit tool is available.',
        'When the shared context names a file and lines, "this" and "here" mean that place: use that path with the read and edit tools.',
      ].join(' ')
    : base
  const sections = req.context.map(contextSection)
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

function chatMessages(req: ChatAssistRequest): ModelMessage[] {
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
