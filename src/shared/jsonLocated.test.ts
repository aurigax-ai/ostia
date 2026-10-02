import { describe, expect, it } from 'vitest'
import { type JsonSyntaxError, type LocatedJson, parseLocatedJson } from './jsonLocated'

function accepted(text: string): LocatedJson {
  const res = parseLocatedJson(text)
  if ('message' in res) throw new Error(`refused: ${res.message}`)
  return res
}

function refused(text: string): JsonSyntaxError {
  const res = parseLocatedJson(text)
  if (!('message' in res)) throw new Error('expected a refusal')
  return res
}

const nestedArrays = (depth: number): string => '['.repeat(depth) + ']'.repeat(depth)
const nestedObjects = (depth: number): string => `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`

describe('parseLocatedJson', () => {
  it('refuses a duplicate property at every depth and points at the second key', () => {
    expect(refused('{"a":1,"a":2}')).toEqual({
      message: "duplicate property 'a'",
      line: 1,
      column: 8,
    })
    expect(refused('{"x":{"a":1,"a":2}}').message).toBe("duplicate property 'a'")
    expect(refused('[{"a":1,"a":2}]').message).toBe("duplicate property 'a'")
    expect(refused('{\n  "a": 1,\n  "b": 2,\n  "a": 3\n}')).toMatchObject({ line: 4, column: 3 })
  })

  it('refuses a duplicate that differs only by escape', () => {
    expect(refused('{"x":{"a":1,"\\u0061":2}}').message).toBe("duplicate property 'a'")
  })

  it('refuses a raw control character in a string and points at it', () => {
    expect(refused('{"a":"x\ty"}')).toEqual({
      message: 'control character in string',
      line: 1,
      column: 8,
    })
    expect(refused('{"a":"x\u0000y"}').message).toBe('control character in string')
    expect(refused('{"a":"\\\\","b":"x\ty"}').column).toBe(17)
    expect(refused('{"a":"\\"\tz"}').column).toBe(9)
  })

  it('accepts escaped control characters and whitespace between tokens', () => {
    expect(accepted('{"a":"x\\u0000y"}').value).toEqual({ a: 'x\u0000y' })
    expect(accepted('{\t"a":\t"\\\\"\r\n}').value).toEqual({ a: '\\' })
  })

  it('accepts nesting up to the limit and refuses one level more', () => {
    expect('message' in parseLocatedJson(nestedArrays(65))).toBe(false)
    expect(refused(nestedArrays(66)).message).toBe('nested too deeply')
    expect('message' in parseLocatedJson(nestedObjects(64))).toBe(false)
    expect(refused(nestedObjects(65)).message).toBe('nested too deeply')
  })

  it('refuses very deep input without overflowing the stack', () => {
    expect(refused('['.repeat(100_000)).message).toBe('nested too deeply')
    expect(refused(nestedObjects(100_000)).message).toBe('nested too deeply')
  })

  it('keeps prototype keys as plain own properties', () => {
    const text = '{"__proto__":{"polluted":true},"constructor":{"prototype":1},"x":{"__proto__":2}}'
    const value = accepted(text).value as Record<string, unknown>
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect(Object.keys(value)).toEqual(['__proto__', 'constructor', 'x'])
    expect(JSON.stringify(value)).toBe(text)
    expect(Object.keys(value.x as object)).toEqual(['__proto__'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it.each([
    ['a line comment', '{"a":1} // c'],
    ['a block comment', '{/* c */"a":1}'],
    ['a trailing comma in an object', '{"a":1,}'],
    ['a trailing comma in an array', '[1,2,]'],
    ['single quotes', "{'a':1}"],
    ['an unquoted key', '{a:1}'],
    ['NaN', '[NaN]'],
    ['Infinity', '[-Infinity]'],
    ['a leading zero', '[01]'],
    ['a leading plus', '[+1]'],
    ['a bare fraction', '[.5]'],
    ['a hex number', '[0x10]'],
    ['a byte order mark', '\ufeff{"a":1}'],
    ['an empty input', ''],
    ['a second document', '{"a":1}{"b":2}'],
    ['a bad escape', '["\\x"]'],
    ['a form feed between tokens', '{\f"a":1}'],
  ])('refuses %s', (_name, text) => {
    expect('message' in parseLocatedJson(text)).toBe(true)
  })

  it('names what is wrong and where', () => {
    expect(refused('{\n"a":1\n}\nxyz')).toEqual({
      message: 'unexpected text after the document',
      line: 4,
      column: 1,
    })
    expect(refused('{\n  "a": 1,\n     "b": @\n}')).toEqual({
      message: "unexpected '@'",
      line: 3,
      column: 11,
    })
    expect(refused('{"a":"abc')).toEqual({ message: 'unterminated string', line: 1, column: 10 })
    expect(refused('{"a":1').message).toBe("expected '}' before the end")
    expect(refused('{a:1}').message).toBe('expected a quoted property name')
  })

  it('parses numbers like JSON.parse', () => {
    const text = '[12345678901234567890, 9007199254740993, 1e3, 1E+3, 1e-3, 1.5e300, -0.0, 0e0]'
    expect(accepted(text).value).toEqual(JSON.parse(text))
  })

  it('keeps a lone surrogate as written', () => {
    expect(accepted('["\\ud800"]').value).toEqual(['\ud800'])
  })

  it('records the line of every path, quoting keys that are not identifiers', () => {
    const text = '{\n "we ird": {"a.b": true,\n "": 1},\n "x": [1,\n {"k y": null}]\n}'
    expect([...accepted(text).lines]).toEqual([
      ['', 1],
      ['["we ird"]', 2],
      ['["we ird"]["a.b"]', 2],
      ['["we ird"][""]', 3],
      ['x', 4],
      ['x[0]', 4],
      ['x[1]', 5],
      ['x[1]["k y"]', 5],
    ])
  })
})
