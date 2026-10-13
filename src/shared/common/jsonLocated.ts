export interface LocatedJson {
  value: unknown
  lines: Map<string, number>
}

export interface JsonSyntaxError {
  message: string
  line: number
  column: number
}

const MAX_NESTING = 64
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

export function childPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`
  if (!IDENTIFIER.test(key)) return `${parent}[${JSON.stringify(key)}]`
  return parent ? `${parent}.${key}` : key
}

class Failure extends Error {
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message)
  }
}

export function parseLocatedJson(text: string): LocatedJson | JsonSyntaxError {
  const lines = new Map<string, number>()
  let i = 0

  const lineAt = (at: number): number => {
    let line = 1
    for (let k = 0; k < at && k < text.length; k++) if (text.charCodeAt(k) === 10) line++
    return line
  }

  let cursorLine = 1
  let cursorAt = 0
  const currentLine = (): number => {
    for (; cursorAt < i; cursorAt++) if (text.charCodeAt(cursorAt) === 10) cursorLine++
    return cursorLine
  }

  const skip = (): void => {
    while (i < text.length) {
      const c = text[i]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++
      else break
    }
  }

  const expect = (c: string): void => {
    if (text[i] !== c) {
      throw new Failure(i >= text.length ? `expected '${c}' before the end` : `expected '${c}'`, i)
    }
    i++
  }

  const readString = (): string => {
    expect('"')
    let out = ''
    while (true) {
      if (i >= text.length) throw new Failure('unterminated string', i)
      const c = text[i]
      if (c === '"') {
        i++
        return out
      }
      if (c.charCodeAt(0) < 0x20) throw new Failure('control character in string', i)
      if (c !== '\\') {
        out += c
        i++
        continue
      }
      const e = text[i + 1]
      if (e === 'u') {
        const hex = text.slice(i + 2, i + 6)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Failure('bad \\u escape', i)
        out += String.fromCharCode(Number.parseInt(hex, 16))
        i += 6
        continue
      }
      const mapped = e === undefined ? undefined : ESCAPES[e]
      if (mapped === undefined) throw new Failure('bad escape', i)
      out += mapped
      i += 2
    }
  }

  const readValue = (path: string, depth: number): unknown => {
    if (depth > MAX_NESTING) throw new Failure('nested too deeply', i)
    skip()
    lines.set(path, currentLine())
    const c = text[i]
    if (c === '{') {
      i++
      const out: Record<string, unknown> = {}
      skip()
      if (text[i] === '}') {
        i++
        return out
      }
      while (true) {
        skip()
        const keyAt = i
        if (text[i] !== '"') throw new Failure('expected a quoted property name', i)
        const key = readString()
        if (Object.hasOwn(out, key)) throw new Failure(`duplicate property '${key}'`, keyAt)
        skip()
        expect(':')
        const value = readValue(childPath(path, key), depth + 1)
        Object.defineProperty(out, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        })
        skip()
        if (text[i] === ',') {
          i++
          continue
        }
        expect('}')
        return out
      }
    }
    if (c === '[') {
      i++
      const out: unknown[] = []
      skip()
      if (text[i] === ']') {
        i++
        return out
      }
      while (true) {
        out.push(readValue(childPath(path, out.length), depth + 1))
        skip()
        if (text[i] === ',') {
          i++
          continue
        }
        expect(']')
        return out
      }
    }
    if (c === '"') return readString()
    for (const [word, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (text.startsWith(word, i)) {
        i += word.length
        return value
      }
    }
    NUMBER.lastIndex = i
    const m = NUMBER.exec(text)
    if (m && m[0].length > 0) {
      i += m[0].length
      return Number(m[0])
    }
    throw new Failure(i >= text.length ? 'unexpected end of file' : `unexpected '${c}'`, i)
  }

  try {
    const value = readValue('', 0)
    skip()
    if (i < text.length) throw new Failure('unexpected text after the document', i)
    return { value, lines }
  } catch (err) {
    if (!(err instanceof Failure)) throw err
    const line = lineAt(err.at)
    const lineStart = text.lastIndexOf('\n', err.at - 1) + 1
    return { message: err.message, line, column: err.at - lineStart + 1 }
  }
}
