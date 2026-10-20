import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sourceFiles } from '../../../../test/sourceFiles'

const ROOT = process.cwd()

const SHIPPED_CSS = [
  ...sourceFiles('node_modules/monaco-editor/esm', '**/*.css'),
  resolve(ROOT, 'node_modules/shadcn/dist/tailwind.css'),
]

function balanced(text: string, from: number, open: string, close: string): string {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close && --depth === 0) return text.slice(from + 1, i)
  }
  return text.slice(from + 1)
}

const TAILWIND_HAS = /(?<![\w-])(?:group-|peer-)?has-(data-|aria-|\[)/g

function attributeHasArguments(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/:has\(/g)) {
    const argument = balanced(text, match.index + ':has'.length, '(', ')')
    if (argument.includes('[')) found.push(`:has(${argument})`)
  }
  for (const match of text.matchAll(TAILWIND_HAS)) {
    if (match[1] !== '[') {
      found.push(text.slice(match.index).split(/[\s"'`:]/)[0])
      continue
    }
    const argument = balanced(text, match.index + match[0].length - 1, '[', ']')
    if (argument.includes('[')) found.push(`${match[0]}${argument}]`)
  }
  return found
}

describe(':has() arguments', () => {
  it('finds attribute selectors in CSS :has() and in Tailwind has-* variants', () => {
    const has = 'has-'
    const sample = [
      `.a:${'has'}(> [data-x]) {}`,
      `.b:${'has'}(> svg) {}`,
      `${has}data-[slot=y]:p-1`,
      `${has}aria-invalid:ring`,
      `group-${has}[>[data-z]]/g:p-0`,
      `${has}[>svg]:grid-cols-[auto_1fr]`,
      `${has}[>.marker]:pt-3`,
    ].join(' ')
    expect(attributeHasArguments(sample)).toEqual([
      `:${'has'}(> [data-x])`,
      `${has}data-[slot=y]`,
      `${has}aria-invalid`,
      `group-${has}[>[data-z]]`,
    ])
  })

  it('no shipped style puts an attribute selector inside :has()', () => {
    const files = [...sourceFiles('src/renderer', '**/*.{ts,tsx,css}'), ...SHIPPED_CSS]
    const found = files.flatMap((file) =>
      attributeHasArguments(readFileSync(file, 'utf8')).map(
        (selector) => `${relative(ROOT, file)}: ${selector}`,
      ),
    )
    expect(found).toEqual([])
  })
})
