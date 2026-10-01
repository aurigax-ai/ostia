import {
  type TCMProtocol,
  createHermesToolResponseFormatter,
  createToolMiddleware,
  hermesProtocol,
  hermesSystemPromptTemplate,
} from '@ai-sdk-tool/parser'
import { type LanguageModel, generateId, simulateStreamingMiddleware, wrapLanguageModel } from 'ai'

type Model = Exclude<LanguageModel, string>
type ParseArgs = Parameters<TCMProtocol['parseGeneratedText']>[0]
type FunctionTool = ParseArgs['tools'][number]
type Content = ReturnType<TCMProtocol['parseGeneratedText']>

export interface ParsedCall {
  name: string
  input: Record<string, unknown>
}

const CODE_FENCE = /```(?:tool_code|tool_call|python|py)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/
const CALL_WRAPPERS = new Set(['print'])

class Reader {
  i = 0

  constructor(readonly text: string) {}

  skip(): void {
    while (this.i < this.text.length && /\s/.test(this.text[this.i])) this.i++
  }

  peek(): string | undefined {
    this.skip()
    return this.text[this.i]
  }

  eat(ch: string): void {
    if (this.peek() !== ch) throw new SyntaxError(`expected ${ch}`)
    this.i++
  }

  done(): boolean {
    this.skip()
    return this.i >= this.text.length
  }

  match(pattern: RegExp): string | null {
    this.skip()
    const m = pattern.exec(this.text.slice(this.i))
    if (!m) return null
    this.i += m[0].length
    return m[0]
  }
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0' }

function readString(r: Reader): string {
  r.skip()
  const quote = r.text[r.i]
  const triple = r.text.startsWith(quote.repeat(3), r.i)
  const end = triple ? quote.repeat(3) : quote
  r.i += end.length
  let out = ''
  while (r.i < r.text.length) {
    if (r.text.startsWith(end, r.i)) {
      r.i += end.length
      return out
    }
    const ch = r.text[r.i++]
    if (ch === '\\' && r.i < r.text.length) {
      const next = r.text[r.i++]
      out += ESCAPES[next] ?? next
    } else if (ch === '\n' && !triple) {
      throw new SyntaxError('unterminated string')
    } else out += ch
  }
  throw new SyntaxError('unterminated string')
}

function readItems(r: Reader, close: string): unknown[] {
  const items: unknown[] = []
  while (r.peek() !== close) {
    items.push(readValue(r))
    if (r.peek() === ',') r.eat(',')
    else break
  }
  r.eat(close)
  return items
}

function readDict(r: Reader): Record<string, unknown> {
  r.eat('{')
  const out: Record<string, unknown> = {}
  while (r.peek() !== '}') {
    const key = readValue(r)
    if (typeof key !== 'string') throw new SyntaxError('dict keys must be strings')
    r.eat(':')
    out[key] = readValue(r)
    if (r.peek() === ',') r.eat(',')
    else break
  }
  r.eat('}')
  return out
}

const LITERALS: Record<string, unknown> = {
  True: true,
  False: false,
  None: null,
  true: true,
  false: false,
  null: null,
}

function readValue(r: Reader): unknown {
  const ch = r.peek()
  if (ch === '"' || ch === "'") return readString(r)
  if (ch === '[') {
    r.eat('[')
    return readItems(r, ']')
  }
  if (ch === '(') {
    r.eat('(')
    return readItems(r, ')')
  }
  if (ch === '{') return readDict(r)
  const number = r.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)
  if (number !== null) return Number(number)
  const word = r.match(/^[A-Za-z_]\w*/)
  if (word !== null && word in LITERALS) return LITERALS[word]
  throw new SyntaxError('unknown value')
}

function readCall(r: Reader, tools: Map<string, FunctionTool>): ParsedCall {
  const path = r.match(/^[A-Za-z_][\w.]*/)
  if (path === null) throw new SyntaxError('expected a call')
  r.eat('(')
  if (CALL_WRAPPERS.has(path)) {
    const inner = readCall(r, tools)
    r.eat(')')
    return inner
  }
  const name = path.slice(path.lastIndexOf('.') + 1)
  const tool = tools.get(name)
  if (!tool) throw new SyntaxError(`unknown tool ${name}`)
  const keys = Object.keys(
    ((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}) as object,
  )
  const input: Record<string, unknown> = {}
  let position = 0
  while (r.peek() !== ')') {
    const keyword = r.match(/^[A-Za-z_]\w*\s*=(?!=)/)
    if (keyword !== null) input[keyword.replace(/\s*=$/, '')] = readValue(r)
    else {
      const key = keys[position++]
      if (key === undefined) throw new SyntaxError('too many arguments')
      input[key] = readValue(r)
    }
    if (r.peek() === ',') r.eat(',')
    else break
  }
  r.eat(')')
  return { name, input }
}

function jsonCall(code: string, tools: Map<string, FunctionTool>): ParsedCall[] | null {
  try {
    const parsed = JSON.parse(code) as { name?: unknown; arguments?: unknown; parameters?: unknown }
    const input = parsed.arguments ?? parsed.parameters ?? {}
    if (typeof parsed.name !== 'string' || !tools.has(parsed.name)) return null
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
    return [{ name: parsed.name, input: input as Record<string, unknown> }]
  } catch {
    return null
  }
}

function callsIn(code: string, tools: Map<string, FunctionTool>): ParsedCall[] | null {
  const trimmed = code.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{')) return jsonCall(trimmed, tools)
  try {
    const r = new Reader(trimmed)
    const calls: ParsedCall[] = []
    while (!r.done()) {
      if (r.peek() === '[') {
        r.eat('[')
        while (r.peek() !== ']') {
          calls.push(readCall(r, tools))
          if (r.peek() === ',') r.eat(',')
          else break
        }
        r.eat(']')
      } else calls.push(readCall(r, tools))
      if (r.peek() === ';') r.eat(';')
    }
    return calls.length > 0 ? calls : null
  } catch {
    return null
  }
}

export function parseToolCode(
  text: string,
  tools: FunctionTool[],
): { calls: ParsedCall[]; text: string } | null {
  const byName = new Map(tools.map((t) => [t.name, t]))
  const fence = CODE_FENCE.exec(text)
  if (fence) {
    const calls = callsIn(fence[1], byName)
    if (!calls) return null
    const around = [text.slice(0, fence.index), text.slice(fence.index + fence[0].length)]
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .join('\n\n')
    return { calls, text: around }
  }
  const calls = callsIn(text, byName)
  return calls ? { calls, text: '' } : null
}

function withToolCode(protocol: TCMProtocol): TCMProtocol {
  return {
    ...protocol,
    parseGeneratedText: (args): Content => {
      const parsed = protocol.parseGeneratedText(args)
      if (parsed.some((part) => part.type === 'tool-call')) return parsed
      const code = parseToolCode(args.text, args.tools)
      if (!code) return parsed
      return [
        ...(code.text ? [{ type: 'text' as const, text: code.text }] : []),
        ...code.calls.map((call) => ({
          type: 'tool-call' as const,
          toolCallId: generateId(),
          toolName: call.name,
          input: JSON.stringify(call.input),
        })),
      ]
    },
  }
}

export function withPromptedTools(model: Model): Model {
  return wrapLanguageModel({
    model,
    middleware: [
      simulateStreamingMiddleware(),
      createToolMiddleware({
        protocol: withToolCode(hermesProtocol()),
        toolSystemPromptTemplate: hermesSystemPromptTemplate,
        toolResponsePromptTemplate: createHermesToolResponseFormatter({
          mediaStrategy: { mode: 'placeholder' },
        }),
      }),
    ],
  })
}
