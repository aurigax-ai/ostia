import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BUILTIN_PLUGINS } from '../src/renderer/plugins/builtin'
import type { Theme } from '../src/renderer/plugins/types'

const CSS = readFileSync(resolve(process.cwd(), 'src/renderer/index.css'), 'utf8')

function primitiveOf(variable: string): string {
  const declared = new RegExp(`--${variable}:\\s*([^;]+);`).exec(CSS)?.[1]?.trim()
  const alias = declared ? /^var\(--([\w-]+)\)$/.exec(declared) : null
  return alias ? primitiveOf(alias[1]) : variable.replace(/^color-/, '')
}

export function backgroundTokenOf(element: Element, variant = ''): string {
  const pattern = new RegExp(`(?:^|\\s)${variant.replace(/[:[\]=]/g, '\\$&')}bg-([\\w-]+)(?:\\s|$)`)
  const token = pattern.exec(element.className)?.[1]
  if (!token) throw new Error(`no ${variant}bg- class on ${element.className}`)
  return primitiveOf(`color-${token}`)
}

export function themesWhereSame(a: string, b: string): string[] {
  const themes: Theme[] = BUILTIN_PLUGINS.flatMap((p) => p.contributes.themes ?? [])
  return themes.filter((t) => t.tokens[a] === t.tokens[b]).map((t) => t.id)
}
