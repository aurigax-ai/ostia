import { type Node, type ParseError, getNodeValue, parseTree } from 'jsonc-parser'

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
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

export function childPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`
  if (!IDENTIFIER.test(key)) return `${parent}[${JSON.stringify(key)}]`
  return parent ? `${parent}.${key}` : key
}

function lineFromOffset(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++
  }
  return line
}

function columnFromOffset(text: string, offset: number): number {
  let lineStart = 0
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) lineStart = i + 1
  }
  return offset - lineStart + 1
}

function checkDuplicateKeys(node: Node | undefined): string | null {
  if (!node || node.type !== 'object' || !node.children) return null
  const seen = new Set<string>()
  for (const child of node.children) {
    if (child.type === 'property' && child.children && child.children.length > 0) {
      const keyNode = child.children[0]
      if (keyNode.value !== undefined) {
        const key = String(keyNode.value)
        if (seen.has(key)) {
          return key
        }
        seen.add(key)
      }
    }
  }
  return null
}

function checkDepth(node: Node | undefined, depth = 0): boolean {
  if (depth > MAX_NESTING) return false
  if (!node || !node.children) return true
  for (const child of node.children) {
    if (!checkDepth(child, depth + 1)) return false
  }
  return true
}

function buildLines(
  lines: Map<string, number>,
  text: string,
  node: Node | undefined,
  path = '',
): void {
  if (!node) return
  if (
    node.type === 'object' ||
    node.type === 'array' ||
    node.type === 'string' ||
    node.type === 'number' ||
    node.type === 'boolean' ||
    node.type === 'null'
  ) {
    lines.set(path, lineFromOffset(text, node.offset))
  }
  if (node.type === 'object' && node.children) {
    for (const child of node.children) {
      if (child.type === 'property' && child.children && child.children.length >= 2) {
        const keyNode = child.children[0]
        const valueNode = child.children[1]
        if (keyNode.value !== undefined) {
          const key = String(keyNode.value)
          const childPath = path === '' ? key : `${path}.${key}`
          buildLines(lines, text, valueNode, childPath)
        }
      }
    }
  }
  if (node.type === 'array' && node.children) {
    let index = 0
    for (const child of node.children) {
      if (
        child.type === 'object' ||
        child.type === 'array' ||
        child.type === 'string' ||
        child.type === 'number' ||
        child.type === 'boolean' ||
        child.type === 'null'
      ) {
        const childPath = `${path}[${index}]`
        buildLines(lines, text, child, childPath)
        index++
      }
    }
  }
}

export function parseLocatedJson(text: string): LocatedJson | JsonSyntaxError {
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (!inString) {
      if (code === 34) inString = true
    } else {
      if (escaped) {
        escaped = false
      } else if (code === 92) {
        escaped = true
      } else if (code === 34) {
        inString = false
      } else if (code < 0x20) {
        return {
          message: 'control character in string',
          line: lineFromOffset(text, i),
          column: columnFromOffset(text, i),
        }
      }
    }
  }

  const errors: ParseError[] = []
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false })

  if (errors.length > 0) {
    const err = errors[0]
    const line = lineFromOffset(text, err.offset)
    const column = columnFromOffset(text, err.offset)
    return {
      message: 'invalid JSON',
      line,
      column,
    }
  }

  if (!root) {
    return {
      message: 'unexpected end of file',
      line: 1,
      column: 1,
    }
  }

  const dupKey = checkDuplicateKeys(root)
  if (dupKey !== null) {
    const keyNode = root.children?.find(
      (c) => c.type === 'property' && c.children?.[0]?.value === dupKey,
    )
    const offset = keyNode?.offset ?? 0
    const line = lineFromOffset(text, offset)
    const column = columnFromOffset(text, offset)
    return {
      message: `duplicate property '${dupKey}'`,
      line,
      column,
    }
  }

  if (!checkDepth(root)) {
    return {
      message: 'nested too deeply',
      line: lineFromOffset(text, root.offset),
      column: columnFromOffset(text, root.offset),
    }
  }

  const lines = new Map<string, number>()
  const value = getNodeValue(root)

  if (typeof value === 'object' && value !== null) {
    if (Object.hasOwn(value, '__proto__')) {
      Object.defineProperty(value, '__proto__', {
        value: value.__proto__,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    if (Object.hasOwn(value, 'constructor')) {
      Object.defineProperty(value, 'constructor', {
        value: value.constructor,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    if (Object.hasOwn(value, 'prototype')) {
      Object.defineProperty(value, 'prototype', {
        value: value.prototype,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
  }

  buildLines(lines, text, root)
  return { value, lines }
}
